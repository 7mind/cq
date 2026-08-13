import { runWorksetCoordinationBundleContract } from "./worksetCoordinationBundleContract.js";
import { fsOwnedWriteFactory } from "./worksetOwnedWriteDurableFactories.js";

runWorksetCoordinationBundleContract(fsOwnedWriteFactory);
