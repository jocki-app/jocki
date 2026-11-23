import "./duckdb";
import { DuckStorage } from "../storage/duckdb";
import { ScopedDuckStorage } from "../storage/scoped";
import { databasePlatform } from "../storage/database";
export class BrowserStorage extends ScopedDuckStorage {
  constructor(private name = "jocki-local") {
    super();
  }
  /** The device catalog is needed briefly; keep its Wasm worker out of workspace memory. */
  async releaseDeviceCatalog() {
    await this.closeScope("device");
  }
  private databaseName(scope: string) {
    return `${this.name}.${scope}`;
  }
  protected async openScope(scope: string) {
    return new DuckStorage({ name: this.databaseName(scope) });
  }
  protected async scopes() {
    const prefix = this.name + ".";
    return [
      "device",
      ...(await databasePlatform().names())
        .filter((name) => name.startsWith(prefix) && !name.endsWith(".device"))
        .map((name) => name.slice(prefix.length)),
    ];
  }
  protected removeScope(scope: string) {
    return databasePlatform().remove(this.databaseName(scope));
  }
}
