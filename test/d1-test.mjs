import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

export async function createTestD1() {
  const sqlite = new DatabaseSync(":memory:");
  const migration = await readFile(
    new URL("../migrations/0001_initial.sql", import.meta.url),
    "utf8"
  );
  sqlite.exec(migration);

  const database = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) {
          values = args;
          return statement;
        },
        async first(columnName) {
          const row = sqlite.prepare(sql).get(...values) ?? null;
          return columnName && row ? row[columnName] ?? null : row;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...values) };
        },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return {
            meta: { changes: Number(result.changes), last_row_id: result.lastInsertRowid }
          };
        }
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };

  return { database, close: () => sqlite.close() };
}
