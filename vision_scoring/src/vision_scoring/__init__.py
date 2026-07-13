"""Assistive beach-volleyball vision scoring.

Public contracts live in explicit submodules.  Keeping package import inert is
intentional: importing the readiness verifier must not eagerly execute the
scoring, inference, authorization, or persistence control plane.
"""

__all__: tuple[str, ...] = ()
