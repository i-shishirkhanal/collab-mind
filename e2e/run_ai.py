"""Start the AI service for the E2E run (cwd must be ai/).

Same as `uvicorn main:app`, except it first loads the test-only uuid_utils shim, which is needed on
Windows machines whose Application Control policy blocks that native DLL (imported by langsmith via
langgraph). On a normal machine/container the real package loads and this is equivalent to uvicorn."""
import os
import sys

sys.path.insert(0, os.getcwd())  # ai/ itself, so uvicorn can import `main`
sys.path.insert(0, os.path.join(os.getcwd(), "tests"))
import uuid_shim  # noqa: F401,E402

import uvicorn  # noqa: E402

uvicorn.run("main:app", host="127.0.0.1", port=int(os.environ.get("AI_PORT", "58000")), log_level="info")
