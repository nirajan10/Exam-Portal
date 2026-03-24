package runner

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
)

type Language string

const (
	LangC      Language = "c"
	LangCPP    Language = "cpp"
	LangPython Language = "python"
)

// RunResult holds the output of a sandboxed code execution.
type RunResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
	TimedOut bool   `json:"timed_out"`
}

// Runner manages ephemeral Docker containers for code execution.
type Runner struct {
	cli *client.Client
}

// New creates a Runner connected to the host Docker daemon via the mounted socket.
func New() (*Runner, error) {
	cli, err := client.NewClientWithOpts(
		client.FromEnv,
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, fmt.Errorf("docker client init: %w", err)
	}
	return &Runner{cli: cli}, nil
}

// WarmUp pulls all sandbox images at startup so the first execution request is fast.
func (r *Runner) WarmUp(ctx context.Context) {
	images := []string{"gcc:latest", "python:3.12-alpine"}
	for _, img := range images {
		log.Printf("runner: pulling image %s", img)
		rc, err := r.cli.ImagePull(ctx, img, image.PullOptions{})
		if err != nil {
			log.Printf("runner: warn: failed to pull %s: %v", img, err)
			continue
		}
		// Drain the pull progress stream so the pull completes
		io.Copy(io.Discard, rc)
		rc.Close()
		log.Printf("runner: image %s ready", img)
	}
}

// imageAndCmd returns the Docker image and shell command for the given language.
// Code is always delivered via stdin — not env vars (visible in docker inspect).
func imageAndCmd(lang Language) (string, []string, error) {
	switch lang {
	case LangC:
		// gcc:latest is the official Debian-based image with gcc + g++ pre-installed.
		// There is no official gcc:*-alpine variant.
		// Compiler errors go to the container's stderr (no 2>&1) so the frontend
		// can display them separately from program output.
		// timeout 8: compilation limit; timeout 5: execution limit (catches infinite loops).
		return "gcc:latest", []string{"sh", "-c",
			"cat > /tmp/main.c && timeout 8 gcc -o /tmp/main /tmp/main.c -lm -lpthread && timeout 5 /tmp/main",
		}, nil
	case LangCPP:
		return "gcc:latest", []string{"sh", "-c",
			"cat > /tmp/main.cpp && timeout 8 g++ -std=c++17 -o /tmp/main /tmp/main.cpp -lm -lpthread && timeout 5 /tmp/main",
		}, nil
	case LangPython:
		// exec(sys.stdin.read()) runs the full script in one interpreter invocation
		return "python:3.12-alpine", []string{"python3", "-c",
			"import sys; exec(sys.stdin.read())",
		}, nil
	default:
		return "", nil, fmt.Errorf("unsupported language: %q", lang)
	}
}

// imageAndCmdEmbed builds an image+command that bakes the source code into the
// command line via base64, leaving the container's stdin free for program input.
// Used by the teacher's "god-mode" runner so they can supply custom stdin data.
func imageAndCmdEmbed(lang Language, code string) (string, []string, error) {
	b64 := base64.StdEncoding.EncodeToString([]byte(code))
	switch lang {
	case LangC:
		return "gcc:latest", []string{"sh", "-c",
			"echo '" + b64 + "' | base64 -d > /tmp/main.c && " +
				"timeout 8 gcc -o /tmp/main /tmp/main.c -lm -lpthread && " +
				"timeout 5 /tmp/main",
		}, nil
	case LangCPP:
		return "gcc:latest", []string{"sh", "-c",
			"echo '" + b64 + "' | base64 -d > /tmp/main.cpp && " +
				"timeout 8 g++ -std=c++17 -o /tmp/main /tmp/main.cpp -lm -lpthread && " +
				"timeout 5 /tmp/main",
		}, nil
	case LangPython:
		return "python:3.12-alpine", []string{"sh", "-c",
			"echo '" + b64 + "' | base64 -d > /tmp/code.py && timeout 5 python3 /tmp/code.py",
		}, nil
	default:
		return "", nil, fmt.Errorf("unsupported language: %q", lang)
	}
}

func pidsLimit(n int64) *int64 { return &n }

// Run executes the provided code in an isolated, ephemeral Docker container.
// The container has no network access, limited memory/CPU/PIDs, and a read-only
// root filesystem. It is forcefully removed after execution regardless of outcome.
//
// programStdin: when non-empty, the code is embedded in the command via base64
// and programStdin is piped to the running program's stdin. When empty, the
// original approach is used (code written to container stdin, no program stdin).
func (r *Runner) Run(ctx context.Context, lang Language, code string, programStdin string) (*RunResult, error) {
	var img string
	var cmd []string
	var err error
	if programStdin != "" {
		img, cmd, err = imageAndCmdEmbed(lang, code)
	} else {
		img, cmd, err = imageAndCmd(lang)
	}
	if err != nil {
		return nil, err
	}

	// 15-second outer hard limit: gives the inner per-phase timeout commands
	// (8s compile + 5s run) enough room to fire cleanly before Docker force-kills
	// the container. Python gets the same budget (5s inner timeout is plenty).
	execCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	resp, err := r.cli.ContainerCreate(execCtx, &container.Config{
		Image:        img,
		Cmd:          cmd,
		OpenStdin:    true,
		StdinOnce:    true,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		// No environment variables — reduces attack surface
	}, &container.HostConfig{
		NetworkMode: "none", // no outbound or inbound network
		Resources: container.Resources{
			Memory:    64 * 1024 * 1024, // 64 MB RAM
			MemorySwap: 64 * 1024 * 1024, // 0 swap (swap = MemorySwap - Memory)
			NanoCPUs:  500_000_000,       // 0.5 CPU cores
			PidsLimit: pidsLimit(50),     // prevent fork bombs
		},
		ReadonlyRootfs: true,                       // immutable root filesystem
		Tmpfs:          map[string]string{"/tmp": "rw,exec,size=10m"}, // writable scratch space (exec needed for compiled binaries)
		SecurityOpt:    []string{"no-new-privileges"},
		AutoRemove:     false, // we manage removal in defer for reliability
	}, nil, nil, "")
	if err != nil {
		return nil, fmt.Errorf("container create: %w", err)
	}

	// Guaranteed cleanup using a fresh context (execCtx may be expired by then)
	defer func() {
		cleanCtx := context.Background()
		if removeErr := r.cli.ContainerRemove(cleanCtx, resp.ID, container.RemoveOptions{Force: true}); removeErr != nil {
			log.Printf("runner: warn: failed to remove container %s: %v", resp.ID, removeErr)
		}
	}()

	// Attach BEFORE starting — prevents a race where output is produced before we attach
	attach, err := r.cli.ContainerAttach(execCtx, resp.ID, container.AttachOptions{
		Stdin:  true,
		Stdout: true,
		Stderr: true,
		Stream: true,
	})
	if err != nil {
		return nil, fmt.Errorf("container attach: %w", err)
	}
	defer attach.Close()

	if err := r.cli.ContainerStart(execCtx, resp.ID, container.StartOptions{}); err != nil {
		return nil, fmt.Errorf("container start: %w", err)
	}

	// Write to container stdin in a goroutine; close when done.
	// When programStdin is set the code is already embedded in the command,
	// so we write programStdin (the actual program input) instead.
	go func() {
		defer attach.CloseWrite()
		if programStdin != "" {
			io.Copy(attach.Conn, strings.NewReader(programStdin)) //nolint:errcheck
		} else {
			io.Copy(attach.Conn, strings.NewReader(code)) //nolint:errcheck
		}
	}()

	// Docker uses a multiplexed stream format with 8-byte frame headers.
	// stdcopy.StdCopy correctly demultiplexes stdout and stderr.
	// Plain io.Copy would mix them and include framing bytes in output.
	var stdout, stderr bytes.Buffer
	_, copyErr := stdcopy.StdCopy(&stdout, &stderr, attach.Reader)

	timedOut := execCtx.Err() == context.DeadlineExceeded
	if timedOut {
		// Force-stop the container immediately (timeout=0)
		stopCtx := context.Background()
		timeout := 0
		r.cli.ContainerStop(stopCtx, resp.ID, container.StopOptions{Timeout: &timeout}) //nolint:errcheck
	}

	if copyErr != nil && !timedOut {
		return nil, fmt.Errorf("stream copy: %w", copyErr)
	}

	// Retrieve exit code; use a fresh context for the wait call
	var exitCode int
	waitCtx, waitCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer waitCancel()
	statusCh, errCh := r.cli.ContainerWait(waitCtx, resp.ID, container.WaitConditionNotRunning)
	select {
	case status := <-statusCh:
		exitCode = int(status.StatusCode)
	case err := <-errCh:
		log.Printf("runner: warn: ContainerWait error: %v", err)
		exitCode = -1
	case <-waitCtx.Done():
		exitCode = -1
	}

	return &RunResult{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: exitCode,
		TimedOut: timedOut,
	}, nil
}
