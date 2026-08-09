"""Future private-permission contract for OAuth credential files."""

from __future__ import annotations

import pytest


@pytest.fixture()
def data_path(monkeypatch, tmp_path):
    """Redirect credential writes to a temporary directory."""
    import app

    monkeypatch.setattr(app, "DATA_PATH", tmp_path)
    yield tmp_path


@pytest.mark.anyio
async def test_auth_restore_writes_0600(client, data_path):
    """Restore creates OAuth and client credential files with mode 0600."""
    response = await client.post(
        "/auth/restore?user_id=userx",
        json={
            "oauth_json": "{\"tok\": 1}",
            "client_id": "cid",
            "client_secret": "sec",
        },
    )
    assert response.status_code == 200
    for name in ["oauth_userx.json", "client_creds_userx.json"]:
        mode = (data_path / name).stat().st_mode & 0o777
        assert mode == 0o600


@pytest.mark.anyio
async def test_auth_restore_tightens_existing_file(client, data_path):
    """Restore tightens a pre-existing OAuth file with loose permissions."""
    oauth_path = data_path / "oauth_usery.json"
    oauth_path.write_text("{}")
    oauth_path.chmod(0o644)

    response = await client.post(
        "/auth/restore?user_id=usery", json={"oauth_json": "{}"}
    )
    assert response.status_code == 200
    assert oauth_path.stat().st_mode & 0o777 == 0o600


@pytest.mark.anyio
async def test_device_code_poll_success_writes_0600(
    client, data_path, monkeypatch
):
    """Successful device polling writes both credential files as mode 0600."""
    import app

    class SuccessfulOAuthCredentials:
        """Return a deterministic successful device-code token."""

        def __init__(self, client_id, client_secret):
            pass

        def token_from_code(self, device_code):
            return {"access_token": "at", "refresh_token": "rt"}

    monkeypatch.setattr(app, "OAuthCredentials", SuccessfulOAuthCredentials)
    response = await client.post(
        "/auth/device-code/poll?user_id=userz",
        json={"client_id": "c", "client_secret": "s", "device_code": "d"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    for name in ["oauth_userz.json", "client_creds_userz.json"]:
        path = data_path / name
        assert path.exists()
        assert path.stat().st_mode & 0o777 == 0o600
