"""Aquilla Agent API client for the QA runner (AQU-2365).

Stdlib only. The issue's design decision said "Python, stdlib + `requests`";
nothing here needs more than `urllib`, so the dependency was dropped rather
than kept for its own sake — an operator can run this with a bare `python3`
and no `pip install` step, which matters because the people running it are
translation mentors, not Python developers.

What this module owns:

* **Error codes as exceptions.** Every API error is `{ error: { code, message } }`
  (`docs/api/QUICKSTART.md`), and the two the runner must never swallow get their
  own types: `ScopeDenied` (a read-only token hitting a write) and
  `PermissionDenied`. Both carry the server's own message.
* **Pagination.** Every list read walks `nextCursor` to exhaustion.
* **Backoff.** 429 and 5xx retry with exponential backoff; at most
  `MAX_CONCURRENT_READS` reads are ever in flight, which here means the client
  is deliberately sequential (the issue's "never more than 3 concurrent reads"
  ceiling, honoured by not going concurrent at all).

Only reads and changeset prepare/commit live here. Choosing *what* to stage is
`stage.py`'s job, and it refuses the forbidden kinds before a request is built.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterator

#: The issue's read-concurrency ceiling. The client is sequential, so this is
#: documentation of an invariant rather than a semaphore.
MAX_CONCURRENT_READS = 3

DEFAULT_TIMEOUT = 60
MAX_RETRIES = 5
BASE_BACKOFF_SECONDS = 1.0


class ApiError(RuntimeError):
    """An error response from the Agent API."""

    def __init__(self, code: str, message: str, status: int, details: Any = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status
        self.details = details


class ScopeDenied(ApiError):
    """`scope_denied` — the token's ceiling falls short; a human must re-mint.

    Not retryable and not about the caller's project role
    (`docs/AGENT-API.md` → Access ceiling). The runner reports it and stops the
    write, keeping every file it has already produced.
    """


class PermissionDenied(ApiError):
    """`permission_denied` — the user's live role falls short."""


class PlanStale(ApiError):
    """`plan_stale` — project state moved since prepare; re-read and re-prepare."""


class ConfirmationRequired(ApiError):
    """`confirmation_required` (428) — a handoff, not a failure.

    Ask mode: a person must open `approval_url` before commit can land. The
    runner surfaces the URL and exits; it never polls or retries in a loop.
    """

    def __init__(self, message: str, approval_url: str | None, changeset_id: str) -> None:
        super().__init__("confirmation_required", message, 428)
        self.approval_url = approval_url
        self.changeset_id = changeset_id


_ERROR_TYPES: dict[str, type[ApiError]] = {
    "scope_denied": ScopeDenied,
    "permission_denied": PermissionDenied,
    "plan_stale": PlanStale,
}


@dataclass
class Identity:
    credential_id: str
    autonomy_mode: str
    access: str
    scope: dict[str, Any]

    @property
    def read_only(self) -> bool:
        return self.access == "read"

    @property
    def ask_mode(self) -> bool:
        return self.autonomy_mode == "ask"


class AgentApi:
    """One token against one sync host."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: int = DEFAULT_TIMEOUT,
        sleep=time.sleep,
        opener=None,
    ) -> None:
        self.base = base_url.rstrip("/") + "/api/v1/external"
        self._token = token
        self._timeout = timeout
        self._sleep = sleep
        self._opener = opener or urllib.request.urlopen
        #: Every call the client made, for the run log's provenance line.
        self.call_log: list[str] = []

    # -- transport --------------------------------------------------------

    def _request(self, method: str, path: str, *, params=None, body=None) -> Any:
        url = f"{self.base}{path}"
        if params:
            query = {k: v for k, v in params.items() if v is not None}
            if query:
                url = f"{url}?{urllib.parse.urlencode(query)}"
        payload = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"

        attempt = 0
        while True:
            request = urllib.request.Request(url, data=payload, headers=headers, method=method)
            try:
                with self._opener(request, timeout=self._timeout) as response:
                    self.call_log.append(f"{method} {path} → {response.status}")
                    raw = response.read().decode("utf-8")
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as exc:
                raw = exc.read().decode("utf-8", errors="replace")
                self.call_log.append(f"{method} {path} → {exc.code}")
                retryable = exc.code == 429 or 500 <= exc.code < 600
                if retryable and attempt < MAX_RETRIES:
                    self._sleep(_backoff(attempt, exc.headers.get("Retry-After")))
                    attempt += 1
                    continue
                raise _to_api_error(exc.code, raw) from exc
            except urllib.error.URLError as exc:
                if attempt < MAX_RETRIES:
                    self._sleep(_backoff(attempt, None))
                    attempt += 1
                    continue
                raise ApiError("network_error", str(exc.reason), 0) from exc

    def _paginate(self, path: str, *, params=None, key: str = "data") -> Iterator[dict]:
        cursor = None
        while True:
            page_params = dict(params or {})
            if cursor:
                page_params["cursor"] = cursor
            page = self._request("GET", path, params=page_params)
            for row in page.get(key) or []:
                yield row
            cursor = page.get("nextCursor")
            if not cursor:
                return

    # -- reads ------------------------------------------------------------

    def me(self) -> Identity:
        body = self._request("GET", "/me")
        return Identity(
            credential_id=str(body.get("credentialId", "")),
            autonomy_mode=str(body.get("autonomyMode") or body.get("mode") or "ask"),
            access=str(body.get("access") or "write"),
            scope=body.get("scope") or {},
        )

    def projects(self) -> list[dict]:
        """Bootstrap read. A token that cannot reach the project stops here.

        Deliberately the first authenticated call the runner makes, so "a run on
        a project the token's owner cannot read stops at GET /projects with a
        clear message" is structurally true rather than a hope.
        """
        return list(self._paginate("/projects"))

    def project(self, project_id: str) -> dict:
        return self._request("GET", f"/projects/{project_id}")

    def files(self, project_id: str) -> list[dict]:
        return list(self._paginate(f"/projects/{project_id}/files"))

    def cells(
        self,
        project_id: str,
        file_id: str,
        *,
        lane: str | None = None,
        since: int | None = None,
        limit: int = 500,
    ) -> tuple[list[dict], dict]:
        """One file's cells, fully paginated.

        Returns the rows plus the last page's envelope, because a `since=` read
        answers with `{ delta: true, changedCellIds: [...] }` and the edited-cells
        mode needs that list, not just the rows.
        """
        rows: list[dict] = []
        envelope: dict = {}
        cursor = None
        while True:
            params: dict[str, Any] = {"limit": limit}
            if lane is not None:
                params["lane"] = lane
            if since is not None:
                params["since"] = since
            if cursor:
                params["cursor"] = cursor
            page = self._request("GET", f"/projects/{project_id}/files/{file_id}/cells", params=params)
            rows.extend(page.get("data") or [])
            envelope = {k: v for k, v in page.items() if k != "data"}
            cursor = page.get("nextCursor")
            if not cursor:
                return rows, envelope

    def cell_history(self, project_id: str, cell_id: str) -> list[dict]:
        body = self._request("GET", f"/projects/{project_id}/cells/{cell_id}/history")
        return body.get("data") or body.get("events") or []

    def terms(self, project_id: str, *, status: str | None = None) -> list[dict]:
        return list(self._paginate(f"/projects/{project_id}/terms", params={"status": status}))

    def term_consistency(
        self, project_id: str, *, lane: str, file_id: str | None = None, only_drift: bool = False
    ) -> dict:
        return self._request(
            "GET",
            f"/projects/{project_id}/terms/consistency",
            params={"lane": lane, "fileId": file_id, "onlyDrift": "1" if only_drift else None},
        )

    def memory(self, project_id: str, *, status: str | None = None, kind: str | None = None) -> dict:
        """Living Memory: `{ brief, data: [entries…] }`, entries fully paginated."""
        path = f"/projects/{project_id}/memory"
        params = {"status": status, "kind": kind}
        first = self._request("GET", path, params=params)
        entries = list(first.get("data") or [])
        cursor = first.get("nextCursor")
        while cursor:
            page = self._request("GET", path, params={**params, "cursor": cursor})
            entries.extend(page.get("data") or [])
            cursor = page.get("nextCursor")
        return {**first, "data": entries, "nextCursor": None}

    def style_rules(self, project_id: str, *, status: str | None = None) -> list[dict]:
        return list(self._paginate(f"/projects/{project_id}/style-rules", params={"status": status}))

    def quality(self, project_id: str, *, lane: str, file_id: str | None = None) -> dict:
        return self._request(
            "GET", f"/projects/{project_id}/quality", params={"lane": lane, "fileId": file_id}
        )

    def comments(self, project_id: str, *, file_id: str | None = None, cell_id: str | None = None) -> list[dict]:
        return list(
            self._paginate(
                f"/projects/{project_id}/comments", params={"fileId": file_id, "cellId": cell_id}
            )
        )

    # -- writes -----------------------------------------------------------

    def prepare(self, project_id: str, commands: list[dict]) -> dict:
        """Stage a changeset. Applies nothing (`docs/api/QUICKSTART.md` §3)."""
        return self._request(
            "POST", f"/projects/{project_id}/changesets", body={"commands": commands}
        )

    def commit(self, project_id: str, changeset_id: str, *, approval_url: str | None = None) -> dict:
        try:
            return self._request(
                "POST", f"/projects/{project_id}/changesets/{changeset_id}/commit"
            )
        except ApiError as exc:
            if exc.code == "confirmation_required" or exc.status == 428:
                raise ConfirmationRequired(exc.message, approval_url, changeset_id) from exc
            raise


def _backoff(attempt: int, retry_after: str | None) -> float:
    if retry_after:
        try:
            return min(float(retry_after), 60.0)
        except ValueError:
            pass
    return BASE_BACKOFF_SECONDS * (2**attempt)


def _to_api_error(status: int, raw: str) -> ApiError:
    code, message, details = "http_error", raw.strip() or f"HTTP {status}", None
    try:
        parsed = json.loads(raw)
        error = parsed.get("error") if isinstance(parsed, dict) else None
        if isinstance(error, dict):
            code = str(error.get("code") or code)
            message = str(error.get("message") or message)
            details = error.get("details")
    except (ValueError, AttributeError):
        pass
    if status == 428 or code == "confirmation_required":
        return ApiError("confirmation_required", message, status, details)
    return _ERROR_TYPES.get(code, ApiError)(code, message, status, details)
