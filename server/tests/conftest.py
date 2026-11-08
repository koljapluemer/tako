import shutil
from pathlib import Path

import ifcopenshell
import pytest

from tako_ifc_mcp import server

EXAMPLES = Path(__file__).resolve().parents[2] / "example_data"
AC20 = EXAMPLES / "AC20-Institute-Var-2.ifc"
MILLIMETRE = EXAMPLES / "external/s-office-archi.ifc"
IFC2X3 = EXAMPLES / "external/bsi-arch-ifc2x3.ifc"
IFC4X3 = EXAMPLES / "external/bsi-arch-ifc4x3.ifc"
ALL_MODELS = [AC20, MILLIMETRE, IFC2X3, IFC4X3]


@pytest.fixture(scope="session")
def ac20():
    return ifcopenshell.open(str(AC20))


@pytest.fixture
def open_session(tmp_path, monkeypatch):
    """Start the real server module on a private copy of a model."""

    def start(model: Path = AC20):
        monkeypatch.setenv("TAKO_MODEL", str(model))
        monkeypatch.setenv("TAKO_WORKDIR", str(tmp_path / "work"))
        monkeypatch.setattr(server, "_session", None)
        monkeypatch.setattr(server, "_index", None)
        return server.session()

    return start
