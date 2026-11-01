"""A renderer that implements UPnP AV version 2 (MediaRenderer:2,
AVTransport:2, RenderingControl:2), driven through the real async-upnp-client
parser - only HTTP and SSDP are faked.

A client that matches service types exactly against ":1" finds no such
renderer at all. Beacon looks services up by id, which carries no version."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from async_upnp_client.client import UpnpRequester
from async_upnp_client.const import HttpRequest, HttpResponse

import delivery.dlna as _dlna_mod
from delivery.dlna import DlnaDelivery
from delivery.manager import discover_dlna

_HOST = "http://10.0.0.7:16500"
_LOCATION = f"{_HOST}/desc.xml"
_NAME = "Living Room Speaker"

_DESCRIPTION = f"""<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:2</deviceType>
    <friendlyName>{_NAME}</friendlyName>
    <manufacturer>Example Audio</manufacturer>
    <modelName>Network Speaker</modelName>
    <UDN>uuid:00000000-0000-0000-0000-000000000001</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:2</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/cm.xml</SCPDURL>
        <controlURL>/Control/ConnectionManager</controlURL>
        <eventSubURL>/Event/ConnectionManager</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:2</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <SCPDURL>/avt.xml</SCPDURL>
        <controlURL>/Control/AVTransport</controlURL>
        <eventSubURL>/Event/AVTransport</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:2</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <SCPDURL>/rc.xml</SCPDURL>
        <controlURL>/Control/RenderingControl</controlURL>
        <eventSubURL>/Event/RenderingControl</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>"""


def _scpd(actions: dict[str, list[tuple[str, str]]], variables: list[str]) -> str:
    action_xml = "".join(
        f"<action><name>{name}</name><argumentList>"
        + "".join(
            f"<argument><name>{arg}</name><direction>in</direction>"
            f"<relatedStateVariable>{var}</relatedStateVariable></argument>"
            for arg, var in args
        )
        + "</argumentList></action>"
        for name, args in actions.items()
    )
    variable_xml = "".join(
        f'<stateVariable sendEvents="no"><name>{v}</name>'
        f"<dataType>{'ui4' if v.endswith('InstanceID') else 'string'}</dataType></stateVariable>"
        for v in variables
    )
    return (
        '<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0">'
        "<specVersion><major>1</major><minor>0</minor></specVersion>"
        f"<actionList>{action_xml}</actionList>"
        f"<serviceStateTable>{variable_xml}</serviceStateTable></scpd>"
    )


_SCPDS = {
    "/cm.xml": _scpd({}, []),
    "/avt.xml": _scpd(
        {"Play": [("InstanceID", "A_ARG_TYPE_InstanceID"), ("Speed", "TransportPlaySpeed")]},
        ["A_ARG_TYPE_InstanceID", "TransportPlaySpeed", "TransportState"],
    ),
    "/rc.xml": _scpd({}, ["Volume"]),
}

_PLAY_RESPONSE = (
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'
    '<s:Body><u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:2"/>'
    "</s:Body></s:Envelope>"
)


class _FakeRenderer(UpnpRequester):
    """Serves the description and SCPDs, and records every SOAP call."""

    def __init__(self, *args, **kwargs) -> None:
        self.soap_calls: list[HttpRequest] = []

    async def async_http_request(self, http_request: HttpRequest) -> HttpResponse:
        path = http_request.url.removeprefix(_HOST)
        if http_request.method == "GET" and path == "/desc.xml":
            return HttpResponse(200, {}, _DESCRIPTION)
        if http_request.method == "GET" and path in _SCPDS:
            return HttpResponse(200, {}, _SCPDS[path])
        if http_request.method == "POST":
            self.soap_calls.append(http_request)
            return HttpResponse(200, {}, _PLAY_RESPONSE)
        return HttpResponse(404, {}, "")


@pytest.fixture
def renderer():
    fake = _FakeRenderer()
    _dlna_mod._device_cache.clear()
    _dlna_mod._location_cache.clear()
    with patch("async_upnp_client.aiohttp.AiohttpRequester", return_value=fake):
        yield fake
    _dlna_mod._device_cache.clear()
    _dlna_mod._location_cache.clear()


def test_discovery_lists_a_version_2_renderer(renderer):
    async def answer_search(async_callback, **kwargs):
        # Such renderers answer the MediaRenderer:1 search, as the UPnP
        # spec requires, and declare :2 only in their description.
        await async_callback({"location": _LOCATION, "usn": "uuid:renderer"})

    with patch("async_upnp_client.search.async_search", new=answer_search):
        result = asyncio.run(discover_dlna())

    assert result == [{"location": _LOCATION, "name": _NAME}]


def test_play_reaches_the_avtransport_2_service(renderer):
    _dlna_mod._location_cache[_NAME.lower()] = _LOCATION

    asyncio.run(DlnaDelivery(_NAME).resume())

    [call] = renderer.soap_calls
    assert call.url == f"{_HOST}/Control/AVTransport"
    assert "AVTransport:2#Play" in call.headers["SOAPAction"]


def test_volume_events_subscribe_on_the_renderingcontrol_2_service(renderer):
    _dlna_mod._location_cache[_NAME.lower()] = _LOCATION
    delivery = DlnaDelivery(_NAME)
    device = asyncio.run(delivery._get_device())

    with patch("core.upnp_events.subscribe", new=AsyncMock(return_value=None)) as subscribe:
        asyncio.run(delivery._subscribe_to_volume_events(device))

    assert subscribe.await_args.args[2] == f"{_HOST}/Event/RenderingControl"
