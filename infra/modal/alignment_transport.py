"""Bounded HTTPS transport for alignment audio and authenticated callbacks."""

import ipaddress
import socket
from urllib.parse import urlparse, urljoin

MAX_AUDIO_BYTES = 95 * 1024 * 1024


def pinned_target(url):
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if (parsed.scheme != "https" or not hostname or parsed.username
            or parsed.password or parsed.fragment
            or hostname == "localhost"
            or hostname.endswith((".local", ".internal"))):
        raise ValueError("Alignment target must be a public HTTPS URL.")
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(
            hostname, parsed.port or 443, type=socket.SOCK_STREAM,
        )}
    except socket.gaierror as error:
        raise ValueError("Alignment target does not resolve.") from error
    if not addresses or any(not ipaddress.ip_address(address).is_global
                            for address in addresses):
        raise ValueError("Alignment target resolves to a non-public address.")
    address = sorted(addresses, key=lambda item: (
        ipaddress.ip_address(item).version, item,
    ))[0]
    netloc = f"[{address}]" if ":" in address else address
    if parsed.port and parsed.port != 443:
        netloc += f":{parsed.port}"
    return parsed._replace(netloc=netloc).geturl(), parsed.netloc, hostname


def fetch_audio(url):
    import httpx

    with httpx.Client(timeout=300, follow_redirects=False) as client:
        for _ in range(6):
            target, host, sni = pinned_target(url)
            with client.stream("GET", target, headers={"Host": host},
                               extensions={"sni_hostname": sni}) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("Audio redirect has no location.")
                    url = urljoin(url, location)
                    continue
                response.raise_for_status()
                data = bytearray()
                for chunk in response.iter_bytes():
                    if len(data) + len(chunk) > MAX_AUDIO_BYTES:
                        raise ValueError("Source audio exceeds the upload limit.")
                    data.extend(chunk)
                return bytes(data)
    raise ValueError("Source audio exceeds the redirect limit.")


def post_result(url, secret, payload):
    import httpx

    target, host, sni = pinned_target(url)
    with httpx.Client(timeout=30, follow_redirects=False) as client:
        response = client.post(
            target, headers={"Host": host, "X-Alignment-Secret": secret},
            extensions={"sni_hostname": sni}, json=payload,
        )
        if response.is_redirect:
            raise ValueError("Alignment callback redirects are not allowed.")
        response.raise_for_status()
