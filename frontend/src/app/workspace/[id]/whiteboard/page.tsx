"use client";

import { use } from "react";
import { Whiteboard } from "@/components/Whiteboard";

export default function WhiteboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Whiteboard workspaceId={id} />;
}
