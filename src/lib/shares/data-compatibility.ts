import type { Share } from "@/db/schema";

export const DATA_GENERATION_HEADER = "x-gallery-data-generation";
export const DATA_SCHEMA_VERSION_HEADER = "x-gallery-data-schema-version";

export type DataCompatibilityError = {
  status: number;
  body: {
    error: string;
    code: "invalid_data_version" | "data_generation_conflict" | "schema_version_conflict";
    dataGeneration: number;
    dataSchemaVersion: number;
  };
};

function parseVersion(value: string | null): number | null | "invalid" {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : "invalid";
}

/** 老客户端不带版本头时保持兼容；新父页面总会带 generation，旧页面在数据空间切换后会失败而不是写错数据。 */
export function checkDataCompatibility(
  headers: Headers,
  share: Pick<Share, "dataGeneration" | "dataSchemaVersion">,
): DataCompatibilityError | null {
  const generation = parseVersion(headers.get(DATA_GENERATION_HEADER));
  const schemaVersion = parseVersion(headers.get(DATA_SCHEMA_VERSION_HEADER));
  const current = {
    dataGeneration: share.dataGeneration,
    dataSchemaVersion: share.dataSchemaVersion,
  };
  if (generation === "invalid" || schemaVersion === "invalid") {
    return {
      status: 400,
      body: { error: "数据版本号不正确", code: "invalid_data_version", ...current },
    };
  }
  if (generation !== null && generation !== share.dataGeneration) {
    return {
      status: 409,
      body: {
        error: `数据空间已切换（当前为 ${share.dataGeneration}），请刷新页面`,
        code: "data_generation_conflict",
        ...current,
      },
    };
  }
  if (schemaVersion !== null && schemaVersion !== share.dataSchemaVersion) {
    return {
      status: 409,
      body: {
        error: `页面要求数据 schema v${schemaVersion}，当前为 v${share.dataSchemaVersion}`,
        code: "schema_version_conflict",
        ...current,
      },
    };
  }
  return null;
}
