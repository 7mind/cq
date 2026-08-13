import {
  createInMemoryWorksetGuardedPlanLifecycleStore,
  createTrustedWorksetManagementAuthority,
} from "../src/index.js";
import { registerWorksetPlanLifecycleContract } from "./worksetPlanLifecycleContract.js";

registerWorksetPlanLifecycleContract({
  name: "in-memory",
  build: async (options = {}) => createInMemoryWorksetGuardedPlanLifecycleStore({
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.afterPlanAdmit === undefined
      ? {}
      : { afterPlanAdmit: options.afterPlanAdmit }),
  }),
});
