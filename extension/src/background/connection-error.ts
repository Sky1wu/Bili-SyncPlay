import { t } from "../shared/i18n";

export function getConnectionErrorMessage(args: {
  healthcheckReachable: boolean;
  extensionOrigin?: string | null;
  reason?: string | null;
}): string {
  if (!args.healthcheckReachable) {
    return t("connectionServerUnreachable");
  }

  if (args.reason && args.reason !== "origin_not_allowed" && args.reason !== "origin_missing") {
    return t("connectionHandshakeRejected");
  }

  const extensionOrigin = args.extensionOrigin?.trim();
  if (extensionOrigin) {
    return t("connectionOriginRejected", { extensionOrigin });
  }

  return t("connectionAllowedOriginsRejected");
}
