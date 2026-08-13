import { runWorksetCoordinationBundleContract } from "./worksetCoordinationBundleContract.js";
import { sqliteOwnedWriteFactory } from "./worksetOwnedWriteDurableFactories.js";

runWorksetCoordinationBundleContract(sqliteOwnedWriteFactory);
