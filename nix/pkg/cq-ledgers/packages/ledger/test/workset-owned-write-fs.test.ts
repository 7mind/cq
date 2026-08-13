import { runWorksetOwnedWriteContract } from "./worksetOwnedWriteContract.js";
import { fsOwnedWriteFactory } from "./worksetOwnedWriteDurableFactories.js";

runWorksetOwnedWriteContract(fsOwnedWriteFactory);
