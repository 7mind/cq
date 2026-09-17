import type { GenericMutationDataSource } from "./genericMutationDataSource.js";
import type { LifecycleRowRepository } from "./lifecycleRowRepository.js";

export type AsyncRepository<Repository> = {
  [Key in keyof Repository]: Repository[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Result> : never;
};

export type AsyncGenericMutationDataSource = AsyncRepository<GenericMutationDataSource>;

export interface AsyncLifecycleRowRepository extends AsyncRepository<Omit<LifecycleRowRepository,
  "publicRows" | "persistPrivateRecords" | "persistImplementationCompletionBindings">> {
  readonly publicRows: AsyncGenericMutationDataSource;
}
