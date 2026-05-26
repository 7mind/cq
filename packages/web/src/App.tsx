import { useEffect } from "react";
import { useConnection } from "./ws/useConnection";
import { attachTitleMirror } from "./ws/titleMirror";
import { Indicator } from "./ws/Indicator";
import { ChatTab } from "./chat/ChatTab";

/**
 * App — root composite component.
 *
 * PR-17: Manager is no longer constructed here. It is built in main.tsx and
 * provided via <ConnectionProvider>. App reads it via useConnection() to wire
 * the document.title mirror; Indicator reads stats via useConnectionStats().
 *
 * PR-21: Replaced "cq is up" placeholder with <ChatTab />.
 */
export default function App(): React.ReactElement {
  const manager = useConnection();

  useEffect(() => {
    const mirror = attachTitleMirror(manager);
    return () => mirror.detach();
  }, [manager]);

  return (
    <>
      <Indicator />
      <ChatTab />
    </>
  );
}
