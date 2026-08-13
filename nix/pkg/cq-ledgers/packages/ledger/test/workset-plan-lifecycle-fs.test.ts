import { registerWorksetPlanLifecycleContract } from "./worksetPlanLifecycleContract.js";
import { fsPlanLifecycleFactory } from "./worksetPlanLifecycleDurableFactories.js";

registerWorksetPlanLifecycleContract(fsPlanLifecycleFactory);
