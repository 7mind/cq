import type { SQL } from "bun";
import { GOALS_LEDGER } from "../src/constants.js";

export function postgresGoalRowLockHook(pool: SQL, afterLock: () => Promise<void>): SQL {
  const afterQuery = (query: unknown, template: unknown, parameters: readonly unknown[]): unknown => {
    const text = Array.isArray(template) ? template.join("?") : typeof template === "string" ? template : "";
    if (parameters[1] !== GOALS_LEDGER || !/SELECT\s+1\s+FROM\s+items[\s\S]*FOR\s+UPDATE/i.test(text)) return query;
    return Promise.resolve(query).then(async (result) => { await afterLock(); return result; });
  };
  const wrap = <Handle extends SQL>(sql: Handle): Handle => new Proxy(sql, {
    apply: (target, _thisArgument, args) => afterQuery(Reflect.apply(target, target, args), args[0], args.slice(1)),
    get: (target, property) => {
      if (property === "begin") return <Result>(callback: SQL.TransactionContextCallback<Result>) =>
        target.begin((transaction) => callback(wrap(transaction)));
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "unsafe" && typeof value === "function") return (text: string, parameters?: readonly unknown[]) =>
        afterQuery(Reflect.apply(value, target, [text, parameters]), text, parameters === undefined ? [] : parameters);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return wrap(pool);
}
