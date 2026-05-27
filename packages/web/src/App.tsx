import { useEffect, useState } from "react";
import { useConnection } from "./ws/useConnection";
import { attachTitleMirror } from "./ws/titleMirror";
import { Indicator } from "./ws/Indicator";
import { ChatTab } from "./chat/ChatTab";
import { HistoryTab } from "./history/HistoryTab";
import { ToastStack } from "./lib/ToastStack";
import { SessionProvider, useSession } from "./chat/SessionContext";
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
 *
 * PR-03 (resume-rework): tab switcher reacts to SessionContext.resumeRequest:
 * when HistoryTab requests a resume, we flip to the Chat tab so the user sees
 * the resumed session.
 */
export default function App(): React.ReactElement {
  const manager = useConnection();

  useEffect(() => {
    const mirror = attachTitleMirror(manager);
    return () => mirror.detach();
  }, [manager]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ToastStack />
      <SessionProvider>
        <AppShell />
      </SessionProvider>
    </div>
  );
}

function AppShell(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>("chat");
  const { resumeRequest } = useSession();

  // PR-03: when a resume is requested from anywhere (currently HistoryTab),
  // switch to the Chat tab so the user sees the resumed session start.
  useEffect(() => {
    if (resumeRequest !== null) {
      setActiveTab("chat");
    }
  }, [resumeRequest]);

  return (
    <>
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
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", paddingRight: 12 }}>
          <Indicator inline />
        </div>
      </nav>
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
    </>
  );
}
