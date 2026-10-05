"""
agents/registry.py — the specialist agents. Each is a prompt plus a tool set plus limits; the loop,
step log, step limit, approval checkpoint and citation handling are shared (agents/engine.py).
"""

from __future__ import annotations

from agents.engine import AgentSpec
from agents.tools import LIST, READ, SEARCH
from llm.types import Task

RESEARCH = AgentSpec(
    key="research",
    title="Research Agent",
    description="Investigates a question across your sources, retrieving and synthesising a cited answer.",
    instructions=(
        "You answer a research question using only the workspace sources. Method: break the question into "
        "2-4 sub-questions, search for each (rephrase and retry when a search is weak), read a whole source "
        "when one clearly matters, then synthesise one structured answer. Note where sources agree, "
        "disagree or are silent."
    ),
    tools=(SEARCH, LIST, READ),
    max_steps=8,
    task=Task.RESEARCH,
)

LITERATURE_REVIEW = AgentSpec(
    key="literature_review",
    title="Literature Review Agent",
    description="Reviews the workspace's sources on a topic and identifies gaps, with a plan the owner approves first.",
    instructions=(
        "You write an academic-style literature review of the workspace sources on a topic. Method: list the "
        "sources, search each theme, then call request_approval with the themes and gaps you will cover. "
        "After approval write the review: an overview, the main themes with what each source contributes, "
        "agreements and contradictions, and a 'Gaps and open questions' section that names what the sources "
        "do not cover. Never invent sources; refer only to those you read."
    ),
    tools=(LIST, SEARCH, READ),
    max_steps=10,
    task=Task.RESEARCH,
    require_approval=True,
)

DEBATE = AgentSpec(
    key="debate",
    title="Debate Agent",
    description="Builds the strongest cases for and against a position or a comparison table, from your sources.",
    instructions=(
        "You weigh a claim or compare options using only the workspace sources. Method: search separately for "
        "evidence in favour and against (or for each option), then answer with: 'Case for', 'Case against', "
        "a comparison table in Markdown when options are being compared, and a balanced 'Verdict' that says "
        "which side the sources support more and how confident that is. If one side has no support in the "
        "sources, say so rather than inventing arguments."
    ),
    tools=(SEARCH, LIST, READ),
    max_steps=8,
    task=Task.RESEARCH,
)

REPORT_BUILDER = AgentSpec(
    key="report_builder",
    title="Report Builder Agent",
    description="Drafts a structured, cited report; the owner approves the outline before it is written.",
    instructions=(
        "You draft a structured report from the workspace sources. Method: gather material with searches, "
        "propose an outline with request_approval (title and section headings with one line each), and after "
        "approval write the full report in Markdown: title, executive summary, the approved sections, "
        "conclusion and a 'Sources' list of the source names you used. Cite passages as [n] throughout."
    ),
    tools=(SEARCH, LIST, READ),
    max_steps=10,
    task=Task.RESEARCH,
    require_approval=True,
)

AGENTS: dict[str, AgentSpec] = {
    a.key: a for a in (RESEARCH, LITERATURE_REVIEW, DEBATE, REPORT_BUILDER)
}
