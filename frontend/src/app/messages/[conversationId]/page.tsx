"use client";

import { use } from "react";
import { MessageThread } from "@/components/messaging/MessageThread";

export default function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = use(params);
  return <MessageThread key={conversationId} conversationId={conversationId} />;
}
