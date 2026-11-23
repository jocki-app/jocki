import registry from "../../../registries/jocki-content-types/registry.json";
import type { ContentType } from "./contracts";
export const contentTypes = registry.types as unknown as ContentType[];
