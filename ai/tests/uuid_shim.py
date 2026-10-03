"""Test-only: see comment below."""

# Importing `main` pulls in langgraph -> langsmith -> uuid_utils (a native
# extension). Some locked-down Windows machines block that DLL via Application
# Control; where it cannot load, stand in a pure-python uuid7 so the HTTP
# contract can still be tested. Irrelevant wherever the real package loads.
try:
    import uuid_utils  # noqa: F401
    import uuid_utils.compat  # noqa: F401
except ImportError:
    import sys
    import types
    import uuid as _uuid

    _shim = types.ModuleType("uuid_utils")
    _compat = types.ModuleType("uuid_utils.compat")
    for _name in ("uuid1", "uuid3", "uuid4", "uuid5", "uuid6", "uuid7", "uuid8", "getnode"):
        _fn = getattr(_uuid, _name, None) or _uuid.uuid4
        setattr(_shim, _name, _fn)
        setattr(_compat, _name, _fn)
    _shim.__version__, _shim.compat = "0", _compat
    sys.modules.update({"uuid_utils": _shim, "uuid_utils.compat": _compat})
    for _m in [m for m in sys.modules if m.startswith("uuid_utils._")]:
        del sys.modules[_m]

