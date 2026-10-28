import { z } from 'zod';

import { cuid } from '../common/id.js';

/**
 * Maximum characters in a single chat message body. Matches WhatsApp's text
 * message limit (65,536) so long-form messages aren't rejected. Attachments
 * and media follow their own size caps elsewhere.
 */
export const CHAT_MESSAGE_MAX_CHARS = 65_536;

export const RoomType = z.enum(['DM', 'GROUP', 'TEXT_CHANNEL', 'VOICE_CHANNEL']);
export type RoomType = z.infer<typeof RoomType>;

export const MessageStatus = z.enum(['SENT', 'DELIVERED', 'READ']);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const CallStatus = z.enum(['RINGING', 'ONGOING', 'COMPLETED', 'MISSED', 'REJECTED']);
export type CallStatus = z.infer<typeof CallStatus>;

export const ChatRoomParticipantRole = z.enum(['ADMIN', 'MEMBER']);
export type ChatRoomParticipantRole = z.infer<typeof ChatRoomParticipantRole>;

export const chatRoomParticipantSchema = z.object({
  id: cuid,
  userId: cuid,
  joinedAt: z.coerce.date(),
  // The DB defaults role to MEMBER (Prisma @default(MEMBER)), so the API
  // always returns a concrete value on the wire.
  role: ChatRoomParticipantRole,
  user: z.object({
    id: cuid,
    name: z.string(),
    email: z.string().email(),
    image: z.string().nullable(),
  }),
});
export type ChatRoomParticipant = z.infer<typeof chatRoomParticipantSchema>;

export const updateParticipantRoleSchema = z.object({
  role: ChatRoomParticipantRole,
});
export type UpdateParticipantRoleInput = z.infer<typeof updateParticipantRoleSchema>;

/**
 * Cross-app "Share to chat" payload. The caller picks a target chat room
 * (DM or Group within their own org) and a source asset; the server emits
 * a synthetic message with content `__share__:TYPE:ID:JSON_PAYLOAD` that
 * renders as a structured card on the receiving end.
 */
export const shareToChatItemType = z.enum(['task', 'timesheet', 'todo', 'email']);
export type ShareToChatItemType = z.infer<typeof shareToChatItemType>;

export const shareToChatSchema = z.object({
  targetRoomId: cuid,
  itemType: shareToChatItemType,
  itemId: cuid,
});
export type ShareToChatInput = z.infer<typeof shareToChatSchema>;

export const shareCardPayloadSchema = z.object({
  itemType: shareToChatItemType,
  itemId: cuid,
  title: z.string(),
  subtitle: z.string().nullable().optional(),
  link: z.string(),
});
export type ShareCardPayload = z.infer<typeof shareCardPayloadSchema>;

export const chatRoomAttachmentSchema = z.object({
  id: cuid,
  messageId: cuid,
  fileUrl: z.string().url(),
  fileType: z.string(),
  fileName: z.string(),
  fileSize: z.number().int().nonnegative(),
});
export type ChatRoomAttachment = z.infer<typeof chatRoomAttachmentSchema>;

export const chatReactionTallySchema = z.object({
  emoji: z.string().max(32),
  count: z.number().int().nonnegative(),
  reactedByMe: z.boolean(),
  userIds: z.array(cuid),
});
export type ChatReactionTally = z.infer<typeof chatReactionTallySchema>;

export const chatMessageParentPreviewSchema = z.object({
  id: cuid,
  senderId: cuid,
  content: z.string().nullable(),
  createdAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type ChatMessageParentPreview = z.infer<typeof chatMessageParentPreviewSchema>;

export const chatRoomMessageSchema = z.object({
  id: cuid,
  roomId: cuid,
  senderId: cuid,
  content: z.string().nullable(),
  status: MessageStatus,
  createdAt: z.coerce.date(),
  // Set when the sender edits the message body; null for never-edited messages.
  editedAt: z.coerce.date().nullable(),
  deletedAt: z.coerce.date().nullable(),
  attachments: z.array(chatRoomAttachmentSchema),
  parentMessageId: cuid.nullable(),
  parentMessage: chatMessageParentPreviewSchema.nullable(),
  reactions: z.array(chatReactionTallySchema),
});
export type ChatRoomMessage = z.infer<typeof chatRoomMessageSchema>;

export const chatRoomSummarySchema = z.object({
  id: cuid,
  type: RoomType,
  name: z.string().nullable(),
  description: z.string().nullable(),
  workspaceId: cuid.nullable(),
  projectId: cuid.nullable(),
  createdById: cuid.nullable().optional(),
  isPrivate: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
  participants: z.array(chatRoomParticipantSchema),
  lastMessage: chatRoomMessageSchema.nullable(),
  unreadCount: z.number().int().nonnegative(),
  /** True for a DM opened from an accepted cross-organization chat request
   *  (participants in different organizations). A flag only - never an org id. */
  spansOrganizations: z.boolean().optional(),
});
export type ChatRoomSummary = z.infer<typeof chatRoomSummarySchema>;

export const chatRoomListResponseSchema = z.object({
  items: z.array(chatRoomSummarySchema),
});
export type ChatRoomListResponse = z.infer<typeof chatRoomListResponseSchema>;

export const chatRoomMessagesResponseSchema = z.object({
  items: z.array(chatRoomMessageSchema),
  nextCursor: z.string().nullable(),
});
export type ChatRoomMessagesResponse = z.infer<typeof chatRoomMessagesResponseSchema>;

export const createChatRoomSchema = z
  .object({
    type: RoomType,
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    participantUserIds: z.array(cuid).max(100).optional(),
    workspaceId: cuid.optional(),
    projectId: cuid.optional(),
    isPrivate: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    const peers = v.participantUserIds ?? [];
    if (v.type === 'DM') {
      if (peers.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['participantUserIds'],
          message: 'A DM must have exactly one other participant.',
        });
      }
      return;
    }
    if (v.type === 'GROUP') {
      if (peers.length < 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['participantUserIds'],
          message: 'A group chat needs at least one other participant.',
        });
      }
      if (!v.name) {
        ctx.addIssue({
          code: 'custom',
          path: ['name'],
          message: 'A group chat needs a name.',
        });
      }
      return;
    }
    if (!v.name) {
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: `${v.type === 'TEXT_CHANNEL' ? 'Text' : 'Voice'} channels need a name.`,
      });
    }
  });
export type CreateChatRoomInput = z.infer<typeof createChatRoomSchema>;

export const chatAttachmentInputSchema = z.object({
  fileUrl: z.string().url(),
  fileType: z.string().min(1).max(120),
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().nonnegative(),
});
export type ChatAttachmentInput = z.infer<typeof chatAttachmentInputSchema>;

export const sendChatMessageBodySchema = z
  .object({
    content: z.string().max(CHAT_MESSAGE_MAX_CHARS).optional(),
    attachments: z.array(chatAttachmentInputSchema).max(10).optional(),
    clientNonce: z.string().min(1).max(64).optional(),
    parentMessageId: cuid.optional(),
  })
  .superRefine((v, ctx) => {
    const hasText = !!v.content && v.content.trim().length > 0;
    const hasFiles = !!v.attachments && v.attachments.length > 0;
    if (!hasText && !hasFiles) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Send some text or attach at least one file.',
      });
    }
  });
export type SendChatMessageBody = z.infer<typeof sendChatMessageBodySchema>;

export const sendChatMessageSchema = z
  .object({
    roomId: cuid,
    content: z.string().max(CHAT_MESSAGE_MAX_CHARS).optional(),
    attachments: z.array(chatAttachmentInputSchema).max(10).optional(),
    clientNonce: z.string().min(1).max(64).optional(),
    parentMessageId: cuid.optional(),
    /** User ids @mentioned in the message. Drives bell notifications for
     *  mentions in channels/groups (DMs notify every participant anyway).
     *  Optional + additive: the composer can populate it incrementally. */
    mentionedUserIds: z.array(cuid).max(50).optional(),
  })
  .superRefine((v, ctx) => {
    const hasText = !!v.content && v.content.trim().length > 0;
    const hasFiles = !!v.attachments && v.attachments.length > 0;
    if (!hasText && !hasFiles) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Send some text or attach at least one file.',
      });
    }
  });
export type SendChatMessageInput = z.infer<typeof sendChatMessageSchema>;

export const listRoomMessagesQuerySchema = z.object({
  roomId: cuid,
  cursor: cuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListRoomMessagesQuery = z.infer<typeof listRoomMessagesQuerySchema>;

/** Edit a message body. Only the original sender may edit, and only the text
 *  (attachments are immutable - delete + resend to change files). */
export const editChatMessageBodySchema = z.object({
  content: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_CHARS),
});
export type EditChatMessageBody = z.infer<typeof editChatMessageBodySchema>;

/** Forward one or more existing messages into another room. The forwarded
 *  copies are plain new messages in the target room (no "forwarded" marker). */
export const forwardChatMessagesBodySchema = z.object({
  targetRoomId: cuid,
  messageIds: z.array(cuid).min(1).max(20),
});
export type ForwardChatMessagesBody = z.infer<typeof forwardChatMessagesBodySchema>;

export const joinRoomSchema = z.object({ roomId: cuid });
export type JoinRoomInput = z.infer<typeof joinRoomSchema>;

export const typingEventSchema = z.object({ roomId: cuid });
export type TypingEventInput = z.infer<typeof typingEventSchema>;

export const markRoomReadSchema = z.object({
  roomId: cuid,
  upToMessageId: cuid.optional(),
});
export type MarkRoomReadInput = z.infer<typeof markRoomReadSchema>;

export const addParticipantsSchema = z.object({
  userIds: z.array(cuid).min(1).max(50),
});
export type AddParticipantsInput = z.infer<typeof addParticipantsSchema>;

export const renameRoomSchema = z.object({
  name: z.string().min(1).max(80),
});
export type RenameRoomInput = z.infer<typeof renameRoomSchema>;

export const updateRoomSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).nullable().optional(),
    /** Toggle channel visibility. true = private (only participants);
     *  false = open to the whole organization. Admin-only, channels only. */
    isPrivate: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.isPrivate !== undefined, {
    message: 'Provide at least one field to update',
  });
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;

export const createInviteSchema = z.object({
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .optional(),
  maxUses: z.number().int().min(1).max(1000).optional(),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const chatRoomInviteSchema = z.object({
  id: cuid,
  roomId: cuid,
  code: z.string(),
  createdById: cuid,
  maxUses: z.number().int().nullable(),
  usedCount: z.number().int().nonnegative(),
  expiresAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type ChatRoomInvite = z.infer<typeof chatRoomInviteSchema>;

export const toggleReactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});
export type ToggleReactionInput = z.infer<typeof toggleReactionSchema>;

export const presenceSnapshotSchema = z.object({
  userIds: z.array(cuid),
});
export type PresenceSnapshot = z.infer<typeof presenceSnapshotSchema>;

export const presenceEventSchema = z.object({
  userId: cuid,
  online: z.boolean(),
  lastSeenAt: z.coerce.date().nullable(),
});
export type PresenceEvent = z.infer<typeof presenceEventSchema>;

export const invitePreviewSchema = z.object({
  code: z.string(),
  room: z.object({
    id: cuid,
    name: z.string().nullable(),
    type: RoomType,
    participantCount: z.number().int().nonnegative(),
  }),
  invitedBy: z.object({
    id: cuid,
    name: z.string(),
    email: z.string().email(),
    image: z.string().nullable(),
  }),
  expired: z.boolean(),
  exhausted: z.boolean(),
  alreadyJoined: z.boolean(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export const webrtcSessionDescriptionSchema = z.object({
  type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
  sdp: z.string().min(1),
});
export type WebrtcSessionDescription = z.infer<typeof webrtcSessionDescriptionSchema>;

export const webrtcIceCandidateSchema = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});
export type WebrtcIceCandidate = z.infer<typeof webrtcIceCandidateSchema>;

export const callInitiateSchema = z.object({
  roomId: cuid,
});
export type CallInitiateInput = z.infer<typeof callInitiateSchema>;

export const callAcceptSchema = z.object({
  callId: cuid,
});
export type CallAcceptInput = z.infer<typeof callAcceptSchema>;

export const callRejectSchema = z.object({
  callId: cuid,
});
export type CallRejectInput = z.infer<typeof callRejectSchema>;

export const callEndSchema = z.object({
  callId: cuid,
});
export type CallEndInput = z.infer<typeof callEndSchema>;

export const callOfferSchema = z.object({
  callId: cuid,
  toUserId: cuid,
  description: webrtcSessionDescriptionSchema,
});
export type CallOfferInput = z.infer<typeof callOfferSchema>;

export const callAnswerSchema = z.object({
  callId: cuid,
  toUserId: cuid,
  description: webrtcSessionDescriptionSchema,
});
export type CallAnswerInput = z.infer<typeof callAnswerSchema>;

export const callIceCandidateSchema = z.object({
  callId: cuid,
  toUserId: cuid,
  candidate: webrtcIceCandidateSchema,
});
export type CallIceCandidateInput = z.infer<typeof callIceCandidateSchema>;

export const callSummarySchema = z.object({
  id: cuid,
  callerId: cuid,
  receiverRoomId: cuid,
  status: CallStatus,
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable(),
});
export type CallSummary = z.infer<typeof callSummarySchema>;

/**
 * People the caller is allowed to start a chat with: always the caller's own
 * organization (root-org members included), independent of the selected
 * workspace. `organization` is kept on the wire for compatibility.
 */
export const chatContactSchema = z.object({
  id: cuid,
  name: z.string(),
  email: z.string().email(),
  image: z.string().nullable(),
  organization: z
    .object({
      id: cuid,
      name: z.string(),
      isRoot: z.boolean(),
    })
    .nullable(),
});
export type ChatContact = z.infer<typeof chatContactSchema>;

export const chatContactsResponseSchema = z.object({
  items: z.array(chatContactSchema),
});
export type ChatContactsResponse = z.infer<typeof chatContactsResponseSchema>;
