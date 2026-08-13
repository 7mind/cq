import { runWorksetCoordinationBundleContract } from "./worksetCoordinationBundleContract.js";
import { gitOwnedWriteFactory } from "./worksetOwnedWriteDurableFactories.js";

runWorksetCoordinationBundleContract(gitOwnedWriteFactory);
