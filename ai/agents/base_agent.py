"""
agents/base_agent.py — Abstract base class for all LangGraph ReAct agents.

What is a ReAct agent?
  ReAct stands for "Reason + Act". The agent loops:
    1. THINK — reason about what to do next (Gemini generates text)
    2. ACT   — call a tool (Python function) if needed
    3. OBSERVE — see the tool result, then repeat until done

What is LangGraph?
  LangGraph is a library that lets you define agent logic as a graph
  of nodes (steps) and edges (transitions).  It handles the loop and
  tool-call plumbing so you don't have to write it by hand.
"""

from abc import ABC, abstractmethod   # ABC = Abstract Base Class — can't be instantiated directly
from typing import Any
from langchain_google_genai import ChatGoogleGenerativeAI   # LangChain wrapper for Gemini
from langgraph.prebuilt import create_react_agent            # Creates a standard ReAct graph


class BaseAgent(ABC):
    """
    Parent class that every specialist agent (StudyCoach, etc.) inherits from.

    It handles:
      - Initialising the Gemini LLM with the correct model name
      - Building the LangGraph ReAct graph via create_react_agent()
      - Providing a single `arun()` method that kicks off the graph

    Subclasses only need to define:
      - `tools`       : the list of Python functions the agent can call
      - `system_prompt` : the high-level instruction that defines the agent's role
    """

    # MODEL is defined at class level so subclasses can override it easily.
    MODEL = "gemini-1.5-flash"

    def __init__(self):
        # Instantiate the Gemini LLM through LangChain's wrapper.
        # temperature=0 means deterministic output — better for factual study answers.
        self.llm = ChatGoogleGenerativeAI(
            model=self.MODEL,
            temperature=0,    # 0 = least random; 1 = most creative
        )

        # create_react_agent wires the LLM + tools into a runnable graph.
        # The graph handles the think → act → observe loop automatically.
        self.graph = create_react_agent(
            model=self.llm,
            tools=self.tools,                    # List of callable tools (defined by subclass)
            prompt=self.system_prompt,   # Prepended to every conversation as context
        )

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
