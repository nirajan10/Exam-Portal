package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// WebSocketUpgrade is Fiber middleware that rejects non-WebSocket requests.
func WebSocketUpgrade() fiber.Handler {
	return func(c *fiber.Ctx) error {
		if websocket.IsWebSocketUpgrade(c) {
			c.Locals("allowed", true)
			return c.Next()
		}
		return fiber.ErrUpgradeRequired
	}
}

// HandleWebSocket returns the websocket.Handler that manages signaling and chat.
func (h *Handler) HandleWebSocket(hub *RoomHub) fiber.Handler {
	return websocket.New(func(c *websocket.Conn) {
		// Generate a unique participant ID for this connection.
		participantID := uuid.New().String()[:8]

		var room *Room
		var participant *Participant

		defer func() {
			if room != nil && participant != nil {
				room.removeParticipant(participantID)

				// Notify others that this participant left.
				leaveMsg, _ := json.Marshal(WSMessage{
					Type:      MsgParticipantLeft,
					From:      participantID,
					Name:      participant.Name,
					Role:      participant.Role,
					Timestamp: time.Now().UnixMilli(),
				})
				room.broadcast(leaveMsg, participantID)

				log.Printf("ws: participant %s (%s) left room %s", participantID, participant.Name, room.ID)
			}
		}()

		for {
			_, rawMsg, err := c.ReadMessage()
			if err != nil {
				// Connection closed.
				break
			}

			var msg WSMessage
			if err := json.Unmarshal(rawMsg, &msg); err != nil {
				sendWSError(c, "invalid message format")
				continue
			}

			switch msg.Type {
			case MsgJoin:
				if msg.Room == "" || msg.Name == "" || msg.Role == "" {
					sendWSError(c, "join requires room, name, and role")
					continue
				}
				if msg.Role != "student" && msg.Role != "teacher" {
					sendWSError(c, "role must be student or teacher")
					continue
				}

				room = hub.getOrCreateRoom(msg.Room)
				participant = &Participant{
					ID:   participantID,
					Name: msg.Name,
					Role: msg.Role,
					Send: make(chan []byte, 64),
				}
				room.addParticipant(participant)

				// Start the write pump for this participant.
				go writePump(c, participant)

				// Send the participant their ID.
				joinAck, _ := json.Marshal(WSMessage{
					Type:      MsgJoin,
					From:      participantID,
					Name:      msg.Name,
					Role:      msg.Role,
					Room:      msg.Room,
					Timestamp: time.Now().UnixMilli(),
				})
				participant.Send <- joinAck

				// Send the current participant list to the new joiner.
				participants := room.listParticipants()
				type pInfo struct {
					ID   string `json:"id"`
					Name string `json:"name"`
					Role string `json:"role"`
				}
				pList := make([]pInfo, 0, len(participants))
				for _, p := range participants {
					pList = append(pList, pInfo{ID: p.ID, Name: p.Name, Role: p.Role})
				}
				pListJSON, _ := json.Marshal(pList)
				listMsg, _ := json.Marshal(WSMessage{
					Type:      MsgParticipantList,
					Message:   string(pListJSON),
					Timestamp: time.Now().UnixMilli(),
				})
				participant.Send <- listMsg

				// Notify all others that a new participant joined.
				joinNotify, _ := json.Marshal(WSMessage{
					Type:      MsgParticipantJoined,
					From:      participantID,
					Name:      msg.Name,
					Role:      msg.Role,
					Timestamp: time.Now().UnixMilli(),
				})
				room.broadcast(joinNotify, participantID)

				log.Printf("ws: participant %s (%s/%s) joined room %s", participantID, msg.Name, msg.Role, msg.Room)

			case MsgOffer, MsgAnswer, MsgICECandidate:
				if room == nil {
					sendWSError(c, "must join a room first")
					continue
				}
				if msg.To == "" {
					sendWSError(c, fmt.Sprintf("%s requires 'to' field", msg.Type))
					continue
				}
				// Relay signaling message to the target peer.
				// Attach sender identity so the receiver can label the stream.
				msg.From = participantID
				msg.Name = participant.Name
				msg.Role = participant.Role
				msg.Timestamp = time.Now().UnixMilli()
				relayData, _ := json.Marshal(msg)
				room.sendTo(msg.To, relayData)

			case MsgChat:
				if room == nil {
					sendWSError(c, "must join a room first")
					continue
				}
				if msg.Message == "" {
					continue
				}
				// Limit chat message length.
				if len(msg.Message) > 2000 {
					msg.Message = msg.Message[:2000]
				}
				chatMsg, _ := json.Marshal(WSMessage{
					Type:      MsgChat,
					From:      participantID,
					Name:      participant.Name,
					Role:      participant.Role,
					Message:   msg.Message,
					Timestamp: time.Now().UnixMilli(),
				})
				// Broadcast chat to everyone in the room including sender.
				room.broadcast(chatMsg, "")


			case MsgKickStudent:
				if room == nil {
					sendWSError(c, "must join a room first")
					continue
				}
				if participant.Role != "teacher" {
					sendWSError(c, "only teachers can kick students")
					continue
				}
				if msg.To == "" {
					sendWSError(c, "kick-student requires 'to' field")
					continue
				}
				msg.From = participantID
				msg.Name = participant.Name
				msg.Role = participant.Role
				msg.Timestamp = time.Now().UnixMilli()
				kickData, _ := json.Marshal(msg)
				room.sendTo(msg.To, kickData)

				log.Printf("ws: teacher %s (%s) kicked %s in room %s", participantID, participant.Name, msg.To, room.ID)
			default:
				sendWSError(c, fmt.Sprintf("unknown message type: %s", msg.Type))
			}
		}
	}, websocket.Config{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
	})
}

// writePump drains the participant's Send channel into the WebSocket.
func writePump(c *websocket.Conn, p *Participant) {
	for msg := range p.Send {
		if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
			break
		}
	}
}

func sendWSError(c *websocket.Conn, message string) {
	errMsg, _ := json.Marshal(WSMessage{
		Type:      MsgError,
		Message:   message,
		Timestamp: time.Now().UnixMilli(),
	})
	c.WriteMessage(websocket.TextMessage, errMsg)
}
