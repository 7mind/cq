import { useEffect, useState } from "react";
import { useConnection } from "./ws/useConnection";
import { attachTitleMirror } from "./ws/titleMirror";
import { Indicator } from "./ws/Indicator";
import { ChatTab } from "./chat/ChatTab";
import { HistoryTab } from "./history/HistoryTab";
import { ToastStack } from "./lib/ToastStack";
import { SessionProvider } from "./chat/SessionContext";
import styles from "./styles/History.module.css";

type TabId = "chat" | "history";

/**
 * App — root composite component.
 *
 * PR-17: Manager is no longer constructed here. It is built in main.tsx and
 * provided via <ConnectionProvider>. App reads it via useConnection() to wire
 * the document.title mirror; Indicator reads stats via useConnectionStats().
 *
 * PR-21: Replaced "cq is up" placeholder with <ChatTab />.
 *
 * PR-42: Added Chat | History tab switcher.
 */
export default function App(): React.ReactElement {
  const manager = useConnection();
  const [activeTab, setActiveTab] = useState<TabId>("chat");

  useEffect(() => {
    const mirror = attachTitleMirror(manager);
    return () => mirror.detach();
  }, [manager]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ToastStack />
      <Indicator />
      <nav className={styles.tabs} role="tablist" aria-label="Main navigation">
        <button
          role="tab"
          aria-selected={activeTab === "chat"}
          className={`${styles.tab} ${activeTab === "chat" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("chat")}
        >
          Chat
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "history"}
          className={`${styles.tab} ${activeTab === "history" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("history")}
        >
          History
        </button>
      </nav>
      <SessionProvider>
        <div
          style={{
            flex: 1,
            overflow: "hidden",
            display: activeTab === "chat" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <ChatTab />
        </div>
        <div
          style={{
            flex: 1,
            overflow: "hidden",
            display: activeTab === "history" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <HistoryTab />
        </div>
      </SessionProvider>
    </div>
  );
}
