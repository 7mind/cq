import { runWorksetOwnedWriteContract } from "./worksetOwnedWriteContract.js";
import { sqliteOwnedWriteFactory } from "./worksetOwnedWriteDurableFactories.js";

runWorksetOwnedWriteContract(sqliteOwnedWriteFactory);
