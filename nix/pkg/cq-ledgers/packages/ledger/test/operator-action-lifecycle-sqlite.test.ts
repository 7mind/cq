import { runOperatorActionLifecycleContract } from "./operatorActionLifecycleContract.js";
import { operatorActionSqliteFixture } from "./operatorActionSqliteFixture.js";

runOperatorActionLifecycleContract("real SQLite / GoodCommunication", operatorActionSqliteFixture);
