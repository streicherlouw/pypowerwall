"""Homebridge's additive policy surface preserves unknown and legacy contracts."""
import json
from io import BytesIO
from unittest.mock import Mock, patch
from urllib.parse import urlencode

from proxy.server import homebridge_state, homebridge_control
from proxy.tests.test_csv_endpoints import UnittestHandler


def test_state_unknown_and_app_scale():
    with patch('proxy.server.pw') as pw, patch('proxy.server.control_secret', 'test'):
        pw.tedapi.v1r = True
        pw.tedapi.get_config.return_value = None
        pw.tedapi.get_backup_events.return_value = None
        pw.grid_status.return_value = None
        state = homebridge_state()
        assert state['grid_charging'] is None
        assert state['reserve'] is None
        assert state['manual_backup'] is None
        pw.tedapi.get_config.return_value = {'site_info': {'backup_reserve_percent': 24},
                                            'default_real_mode': 'self_consumption'}
        pw.tedapi.get_backup_events.return_value = {'manual_backup': None}
        state = homebridge_state()
        assert state['reserve'] == 20
        assert state['grid_charging'] is True
        assert state['manual_backup'] is False
        pw.tedapi.get_config.assert_called_with(force=True)


def test_controls_validate_and_preserve_app_scale():
    with patch('proxy.server.pw') as pw:
        pw.tedapi.v1r = True
        pw.set_operation.return_value = {'set_backup_reserve_percent': {}}
        assert homebridge_control(json.dumps({'action': 'reserve', 'value': 0})) == {'accepted': True}
        pw.set_operation.assert_called_once_with(level=0)
        for value in [-1, 101, True, '20', None]:
            assert 'error' in homebridge_control(json.dumps({'action': 'reserve', 'value': value}))
        assert 'error' in homebridge_control('[]')
        assert 'error' in homebridge_control('{')
        pw.go_off_grid.return_value = {'result': 0}
        assert 'error' in homebridge_control('{"action":"go_off_grid","value":true}')
        pw.go_off_grid.return_value = {'result': 1}
        assert homebridge_control('{"action":"go_off_grid","value":true}')['accepted']
        pw.go_off_grid.assert_called_with(confirm=True)


def test_homebridge_post_uses_existing_token_gate():
    for token, expected in [('wrong', False), ('test', True)]:
        handler = UnittestHandler()
        handler.path = '/control/homebridge'
        body = urlencode({'token': token, 'value': '{"action":"reserve","value":20}'}).encode()
        handler.headers = {'Content-Length': str(len(body))}
        handler.rfile = BytesIO(body)
        with patch('proxy.server.pw') as pw, patch('proxy.server.control_secret', 'test'), \
                patch('proxy.server.homebridge_control', return_value={'accepted': True}) as control:
            pw.tedapi.v1r = True
            handler.do_POST()
            assert control.called is expected


def test_homebridge_get_route_and_unsupported_transport():
    handler = UnittestHandler()
    handler.path = '/homebridge/state'
    with patch('proxy.server.pw') as pw:
        pw.tedapi = None
        handler.do_GET()
        assert json.loads(handler.wfile.getvalue()) == {'supported': False, 'controls_enabled': False}
