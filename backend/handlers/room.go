package handlers

import (
	"encoding/json"
	"log"
	"sync"
	"time"
)

// ── WebSocket message types ──────────────────────────────────────────────────

type WSMessageType string

const (
	// Signaling
	MsgJoin         WSMessageType = "join"
	MsgLeave        WSMessageType = "leave"
	MsgOffer        WSMessageType = "offer"
	MsgAnswer       WSMessageType = "answer"
	MsgICECandidate WSMessageType = "ice-candidate"

	// Participant events (broadcast by server)
	MsgParticipantJoined WSMessageType = "participant-joined"
	MsgParticipantLeft   WSMessageType = "participant-left"
	MsgParticipantList   WSMessageType = "participant-list"

	// Chat
	MsgChat WSMessageType = "chat"

	// Moderation (teacher → student via server)
	MsgKickStudent WSMessageType = "kick-student"

	// Error
	MsgError WSMessageType = "error"
)

// WSMessage is the envelope for all WebSocket communication.
type WSMessage struct {
	Type      WSMessageType   `json:"type"`
	From      string          `json:"from,omitempty"`
	To        string          `json:"to,omitempty"`
	Name      string          `json:"name,omitempty"`
	Role      string          `json:"role,omitempty"`      // "student" | "teacher"
	Room      string          `json:"room,omitempty"`      // exam ID as string
	SDP       json.RawMessage `json:"sdp,omitempty"`       // RTCSessionDescription
	Candidate json.RawMessage `json:"candidate,omitempty"` // RTCIceCandidate
	Message   string          `json:"message,omitempty"`   // chat text
	Timestamp int64           `json:"timestamp,omitempty"` // unix ms
}

// ── Participant ──────────────────────────────────────────────────────────────

type Participant struct {
	ID   string // unique per connection
	Name string
	Role string // "student" | "teacher"
	Send chan []byte
}

// ── Room ─────────────────────────────────────────────────────────────────────

type Room struct {
	ID           string
	mu           sync.RWMutex
	participants map[string]*Participant
}

func newRoom(id string) *Room {
	return &Room{
		ID:           id,
		participants: make(map[string]*Participant),
	}
}

func (r *Room) addParticipant(p *Participant) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.participants[p.ID] = p
}

func (r *Room) removeParticipant(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.participants[id]; ok {
		close(p.Send)
		delete(r.participants, id)
	}
}

func (r *Room) getParticipant(id string) *Participant {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.participants[id]
}

func (r *Room) listParticipants() []Participant {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Participant, 0, len(r.participants))
	for _, p := range r.participants {
		out = append(out, Participant{ID: p.ID, Name: p.Name, Role: p.Role})
	}
	return out
}

// broadcast sends to all participants except the sender.
func (r *Room) broadcast(msg []byte, excludeID string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for id, p := range r.participants {
		if id == excludeID {
			continue
		}
		select {
		case p.Send <- msg:
		default:
			// Slow consumer — drop message rather than blocking.
			log.Printf("room %s: dropping message for slow participant %s", r.ID, id)
		}
	}
}

// sendTo sends a message to a specific participant.
func (r *Room) sendTo(targetID string, msg []byte) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if p, ok := r.participants[targetID]; ok {
		select {
		case p.Send <- msg:
		default:
			log.Printf("room %s: dropping targeted message for %s", r.ID, targetID)
		}
	}
}

func (r *Room) isEmpty() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.participants) == 0
}

// ── RoomHub — manages all rooms ─────────────────────────────────────────────

type RoomHub struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

func NewRoomHub() *RoomHub {
	hub := &RoomHub{rooms: make(map[string]*Room)}
	go hub.cleanup()
	return hub
}

func (h *RoomHub) getOrCreateRoom(id string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[id]; ok {
		return r
	}
	r := newRoom(id)
	h.rooms[id] = r
	log.Printf("room hub: created room %s", id)
	return r
}

func (h *RoomHub) removeRoom(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.rooms, id)
	log.Printf("room hub: removed room %s", id)
}

// cleanup periodically removes empty rooms.
func (h *RoomHub) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		h.mu.Lock()
		for id, r := range h.rooms {
			if r.isEmpty() {
				delete(h.rooms, id)
				log.Printf("room hub: cleaned up empty room %s", id)
			}
		}
		h.mu.Unlock()
	}
}
