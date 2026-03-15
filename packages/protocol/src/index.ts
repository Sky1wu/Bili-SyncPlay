export { normalizeBilibiliUrl, parseBilibiliVideoRef, type BilibiliVideoRef } from "./video-ref.js";

export type RoomCode = string;
export type PlaybackPlayState = "playing" | "paused" | "buffering";
export type ErrorCode =
  | "origin_not_allowed"
  | "room_not_found"
  | "join_token_invalid"
  | "member_token_invalid"
  | "not_in_room"
  | "rate_limited"
  | "invalid_message"
  | "payload_too_large"
  | "room_full"
  | "internal_error";

export interface SharedVideo {
  videoId: string;
  url: string;
  title: string;
  sharedByMemberId?: string;
}

export interface PlaybackState {
  url: string;
  currentTime: number;
  playState: PlaybackPlayState;
  playbackRate: number;
  updatedAt: number;
  serverTime: number;
  actorId: string;
  seq: number;
}

export interface RoomMember {
  id: string;
  name: string;
}

export interface RoomState {
  roomCode: RoomCode;
  sharedVideo: SharedVideo | null;
  playback: PlaybackState | null;
  members: RoomMember[];
}

export interface ClientHelloPayload {
  displayName?: string;
}

export interface CreateRoomMessage {
  type: "room:create";
  payload?: ClientHelloPayload;
}

export interface JoinRoomMessage {
  type: "room:join";
  payload: {
    roomCode: RoomCode;
    joinToken: string;
    displayName?: string;
  };
}

export interface LeaveRoomMessage {
  type: "room:leave";
  payload?: {
    memberToken?: string;
  };
}

export interface ShareVideoMessage {
  type: "video:share";
  payload: {
    memberToken: string;
    video: SharedVideo;
  };
}

export interface PlaybackUpdateMessage {
  type: "playback:update";
  payload: {
    memberToken: string;
    playback: PlaybackState;
  };
}

export interface SyncRequestMessage {
  type: "sync:request";
  payload: {
    memberToken: string;
  };
}

export interface SyncPingMessage {
  type: "sync:ping";
  payload: {
    clientSendTime: number;
  };
}

export type ClientMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | LeaveRoomMessage
  | ShareVideoMessage
  | PlaybackUpdateMessage
  | SyncRequestMessage
  | SyncPingMessage;

export interface RoomCreatedMessage {
  type: "room:created";
  payload: {
    roomCode: RoomCode;
    memberId: string;
    joinToken: string;
    memberToken: string;
  };
}

export interface RoomJoinedMessage {
  type: "room:joined";
  payload: {
    roomCode: RoomCode;
    memberId: string;
    memberToken: string;
  };
}

export interface RoomStateMessage {
  type: "room:state";
  payload: RoomState;
}

export interface ErrorMessage {
  type: "error";
  payload: {
    code: ErrorCode;
    message: string;
  };
}

export interface SyncPongMessage {
  type: "sync:pong";
  payload: {
    clientSendTime: number;
    serverReceiveTime: number;
    serverSendTime: number;
  };
}

export type ServerMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomStateMessage
  | ErrorMessage
  | SyncPongMessage;

const PLAYBACK_PLAY_STATES: PlaybackPlayState[] = ["playing", "paused", "buffering"];
const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const DISPLAY_NAME_MAX_LENGTH = 32;
const TITLE_MAX_LENGTH = 128;
const URL_MAX_LENGTH = 512;
const TOKEN_MIN_LENGTH = 16;
const TOKEN_MAX_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasStringLengthInRange(value: string, minLength: number, maxLength: number): boolean {
  return value.length >= minLength && value.length <= maxLength;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return isString(value) && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || isBoundedString(value, maxLength);
}

export function isRoomCode(value: unknown): value is RoomCode {
  return isString(value) && ROOM_CODE_PATTERN.test(value);
}

export function isToken(value: unknown): value is string {
  return isString(value) && hasStringLengthInRange(value, TOKEN_MIN_LENGTH, TOKEN_MAX_LENGTH);
}

export function isPlaybackPlayState(value: unknown): value is PlaybackPlayState {
  return isString(value) && PLAYBACK_PLAY_STATES.includes(value as PlaybackPlayState);
}

export function isClientHelloPayload(value: unknown): value is ClientHelloPayload {
  return isRecord(value) && isOptionalBoundedString(value.displayName, DISPLAY_NAME_MAX_LENGTH);
}

export function isSharedVideo(value: unknown): value is SharedVideo {
  return (
    isRecord(value) &&
    isBoundedString(value.videoId, TITLE_MAX_LENGTH) &&
    isBoundedString(value.url, URL_MAX_LENGTH) &&
    isBoundedString(value.title, TITLE_MAX_LENGTH) &&
    isOptionalBoundedString(value.sharedByMemberId, DISPLAY_NAME_MAX_LENGTH)
  );
}

export function isPlaybackState(value: unknown): value is PlaybackState {
  return (
    isRecord(value) &&
    isBoundedString(value.url, URL_MAX_LENGTH) &&
    isFiniteNumber(value.currentTime) &&
    isPlaybackPlayState(value.playState) &&
    isFiniteNumber(value.playbackRate) &&
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.serverTime) &&
    isString(value.actorId) &&
    isFiniteNumber(value.seq)
  );
}

function isCreateRoomMessage(value: unknown): value is CreateRoomMessage {
  return isRecord(value) && value.type === "room:create" && (value.payload === undefined || isClientHelloPayload(value.payload));
}

function isJoinRoomPayload(value: unknown): value is JoinRoomMessage["payload"] {
  return (
    isRecord(value) &&
    isRoomCode(value.roomCode) &&
    isToken(value.joinToken) &&
    isOptionalBoundedString(value.displayName, DISPLAY_NAME_MAX_LENGTH)
  );
}

function isJoinRoomMessage(value: unknown): value is JoinRoomMessage {
  return isRecord(value) && value.type === "room:join" && isJoinRoomPayload(value.payload);
}

function isLeaveRoomPayload(value: unknown): value is NonNullable<LeaveRoomMessage["payload"]> {
  return isRecord(value) && (value.memberToken === undefined || isToken(value.memberToken));
}

function isLeaveRoomMessage(value: unknown): value is LeaveRoomMessage {
  return (
    isRecord(value) &&
    value.type === "room:leave" &&
    (value.payload === undefined || isLeaveRoomPayload(value.payload))
  );
}

function isShareVideoPayload(value: unknown): value is ShareVideoMessage["payload"] {
  return isRecord(value) && isToken(value.memberToken) && isSharedVideo(value.video);
}

function isShareVideoMessage(value: unknown): value is ShareVideoMessage {
  return isRecord(value) && value.type === "video:share" && isShareVideoPayload(value.payload);
}

function isPlaybackUpdatePayload(value: unknown): value is PlaybackUpdateMessage["payload"] {
  return isRecord(value) && isToken(value.memberToken) && isPlaybackState(value.playback);
}

function isPlaybackUpdateMessage(value: unknown): value is PlaybackUpdateMessage {
  return isRecord(value) && value.type === "playback:update" && isPlaybackUpdatePayload(value.payload);
}

function isSyncRequestPayload(value: unknown): value is SyncRequestMessage["payload"] {
  return isRecord(value) && isToken(value.memberToken);
}

function isSyncRequestMessage(value: unknown): value is SyncRequestMessage {
  return isRecord(value) && value.type === "sync:request" && isSyncRequestPayload(value.payload);
}

function isSyncPingPayload(value: unknown): value is SyncPingMessage["payload"] {
  return isRecord(value) && isFiniteNumber(value.clientSendTime);
}

function isSyncPingMessage(value: unknown): value is SyncPingMessage {
  return isRecord(value) && value.type === "sync:ping" && isSyncPingPayload(value.payload);
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || !isString(value.type)) {
    return false;
  }

  switch (value.type) {
    case "room:create":
      return isCreateRoomMessage(value);
    case "room:join":
      return isJoinRoomMessage(value);
    case "room:leave":
      return isLeaveRoomMessage(value);
    case "video:share":
      return isShareVideoMessage(value);
    case "playback:update":
      return isPlaybackUpdateMessage(value);
    case "sync:request":
      return isSyncRequestMessage(value);
    case "sync:ping":
      return isSyncPingMessage(value);
    default:
      return false;
  }
}
