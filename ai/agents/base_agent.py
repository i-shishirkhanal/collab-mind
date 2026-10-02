"""
agents/base_agent.py — Abstract base class for all LangGraph ReAct agents.

What is a ReAct agent?
  ReAct stands for "Reason + Act". The agent loops:
    1. THINK — reason about what to do next (the LLM generates text)
    2. ACT   — call a tool (Python function) if needed
    3. OBSERVE — see the tool result, then repeat until done

What is LangGraph?
  LangGraph is a library that lets you define agent logic as a graph
  of nodes (steps) and edges (transitions).  It handles the loop and
  tool-call plumbing so you don't have to write it by hand.
"""

from abc import ABC, abstractmethod   # ABC = Abstract Base Class — can't be instantiated directly
from typing import Any
from langgraph.prebuilt import create_react_agent            # Creates a standard ReAct graph


class BaseAgent(ABC):
    """
    Parent class that every specialist agent (StudyCoach, etc.) inherits from.

    It handles:
      - Initialising the DeepSeek chat model (OpenAI-compatible) with the correct model name
      - Building the LangGraph ReAct graph via create_react_agent()
      - Providing a single `arun()` method that kicks off the graph

    Subclasses only need to define:
      - `tools`       : the list of Python functions the agent can call
      - `system_prompt` : the high-level instruction that defines the agent's role
    """

    # MODEL is defined at class level so subclasses can override it easily.
    MODEL = None  # None -> LLM_MODEL_FLASH (Task.STUDY routes to Flash)

    def __init__(self):
        # The ReAct graph needs a LangChain chat model with tool calling.
        # DeepSeek's API is OpenAI-compatible, so we point langchain-openai at
        # it using the same validated settings as the model router. The model
        # is built lazily so the service starts (and /health works) without a
        # key; the first use then fails with a clear error.
        self._graph = None

    @property
    def graph(self):
        if self._graph is None:
            from langchain_openai import ChatOpenAI   # imported lazily: optional at import time

            from config import get_settings
            from llm.errors import NotConfiguredError

            s = get_settings().llm
            if not s.api_key:
                raise NotConfiguredError("DEEPSEEK_API_KEY is not configured.", provider="deepseek")
            self.llm = ChatOpenAI(
                model=self.MODEL or s.model_flash,
                base_url=s.base_url,
                api_key=s.api_key,
                temperature=0,
                timeout=s.timeout_seconds,
                max_retries=s.max_retries,
                # Tool-calling turns with thinking enabled require passing
                # reasoning_content back; keep the agent in non-thinking mode.
                extra_body={"thinking": {"type": "disabled"}},
            )
            self._graph = create_react_agent(model=self.llm, tools=self.tools, prompt=self.system_prompt)
        return self._graph

    @property
    @abstractmethod
    def tools(self) -> list:
        """
        Subclasses must return the list of tools this agent can use.
        Using @abstractmethod forces subclasses to implement it.
        """
        ...

    @property
    @abstractmethod
    def system_prompt(self) -> str:
        """
        Subclasses must return the system instruction string for the agent.
        """
        ...

    async def arun(self, user_message: str, workspace_id: str) -> str:
        """
        Run the agent and return its final text answer.

        We pass `workspace_id` in the messages so any tool the agent calls
        can use it to scope DB queries — maintaining the isolation guarantee.
        """
        # LangGraph expects the input in this exact shape.
        # The "messages" key maps to the HumanMessage list inside the graph state.
        inputs = {
            "messages": [
                {"role": "user", "content": user_message},
            ],
            # Extra state that tools can read from the graph's shared state dict.
            "workspace_id": workspace_id,
        }

        # ainvoke() is the async version of invoke() — it runs the full graph
        # and resolves when the agent reaches an END node.
        result = await self.graph.ainvoke(inputs)

        # The final agent message is always the last item in result["messages"].
        # .content extracts the plain text from the AIMessage object.
        return result["messages"][-1].content
