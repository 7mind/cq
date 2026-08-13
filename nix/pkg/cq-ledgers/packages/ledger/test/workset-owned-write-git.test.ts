import { runWorksetOwnedWriteContract } from "./worksetOwnedWriteContract.js";
import { gitOwnedWriteFactory } from "./worksetOwnedWriteDurableFactories.js";

runWorksetOwnedWriteContract(gitOwnedWriteFactory);
