import { LedgerError } from "../types.js";

interface RepositoryRead<Source> { execute(source: Source): unknown }
export type RepositoryReadProgram<Source, Result> = Generator<RepositoryRead<Source>, Result, unknown>;

export function* repositoryRead<Source, Result>(execute: (source: Source) => Result | Promise<Result>): RepositoryReadProgram<Source, Result> {
  // The interpreter resumes this suspension with the result of precisely this read.
  return (yield { execute }) as Result;
}

export function runRepositoryReads<Source, Result>(source: Source, program: RepositoryReadProgram<Source, Result>): Result {
  let step = program.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = step.value.execute(source);
      if (value instanceof Promise) throw new LedgerError("a synchronous repository returned an asynchronous read");
    } catch (error) { step = program.throw(error); continue; }
    step = program.next(value);
  }
  return step.value;
}

export async function runAsyncRepositoryReads<Source, Result>(source: Source, program: RepositoryReadProgram<Source, Result>): Promise<Result> {
  let step = program.next();
  while (!step.done) {
    let value: unknown;
    try { value = await step.value.execute(source); }
    catch (error) { step = program.throw(error); continue; }
    step = program.next(value);
  }
  return step.value;
}
