import type { SQL } from "bun";

export class PostgresStatementFaults {
  private failAt: number | null = null;
  private seen = 0;

  constructor(private readonly message: string) {}

  armAt(nth: number): void { this.failAt = nth; this.seen = 0; }
  disarm(): void { this.failAt = null; }

  wrap<Handle extends SQL>(sql: Handle): Handle {
    return new Proxy(sql, {
      apply: (target, _thisArgument, args) => { this.count(); return Reflect.apply(target, target, args); },
      get: (target, property) => {
        if (property === "begin") return <Result>(callback: SQL.TransactionContextCallback<Result>) =>
          target.begin((transaction) => callback(this.wrap(transaction)));
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "unsafe" && typeof value === "function") return (...args: unknown[]) => {
          this.count(); return Reflect.apply(value, target, args);
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private count(): void {
    if (this.failAt === null) return;
    this.seen++;
    if (this.seen === this.failAt) throw new Error(this.message);
  }
}
