"""Phase 4 regression: IPv6 spellings of internal IPv4 addresses must be blocked on every Python version."""

import ipaddress
import socket

import pytest

from rag import extractor


@pytest.mark.parametrize("addr", [
    "127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "0.0.0.0",
    "::1", "::", "fe80::1", "fd00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe",
    "::7f00:1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2002:a9fe:a9fe::1",
])
def test_internal_addresses_are_blocked(addr, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(0, 0, 0, "", (addr, 0))])
    assert extractor._is_public_host("whatever.example") is False


@pytest.mark.parametrize("addr", ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
# (NAT64 64:ff9b::/96 stays blocked even when it wraps a public IPv4: Python classifies the whole
#  range as non-global, and refusing is the safe side.)
def test_public_addresses_are_allowed(addr, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(0, 0, 0, "", (addr, 0))])
    assert extractor._is_public_host("whatever.example") is True


def test_one_internal_answer_among_public_ones_blocks_the_host(monkeypatch):
    answers = [(0, 0, 0, "", ("8.8.8.8", 0)), (0, 0, 0, "", ("::ffff:7f00:1", 0, 0, 0))]
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: answers)
    assert extractor._is_public_host("rebind.example") is False


def test_unresolvable_host_is_blocked(monkeypatch):
    def boom(*a, **k):
        raise socket.gaierror("no such host")
    monkeypatch.setattr(socket, "getaddrinfo", boom)
    assert extractor._is_public_host("nope.invalid") is False
