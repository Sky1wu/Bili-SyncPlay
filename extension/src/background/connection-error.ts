export function getConnectionErrorMessage(args: {
  healthcheckReachable: boolean;
  extensionOrigin?: string | null;
  reason?: string | null;
}): string {
  if (!args.healthcheckReachable) {
    return "无法连接到同步服务器。";
  }

  if (args.reason && args.reason !== "origin_not_allowed" && args.reason !== "origin_missing") {
    return "服务器可达，但 WebSocket 握手被拒绝。请检查服务端状态，以及反向代理是否已正确转发 WebSocket。";
  }

  const extensionOrigin = args.extensionOrigin?.trim();
  if (extensionOrigin) {
    return `服务器可达，但 WebSocket 握手被拒绝。请检查服务端 ALLOWED_ORIGINS 是否包含 ${extensionOrigin}，以及反向代理是否已正确转发 WebSocket。`;
  }

  return "服务器可达，但 WebSocket 握手被拒绝。请检查服务端 ALLOWED_ORIGINS，以及反向代理是否已正确转发 WebSocket。";
}
