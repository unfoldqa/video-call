#!/usr/bin/env python3
"""Signaling + static file server for video calls."""

import json
import os
from pathlib import Path

from aiohttp import web

PORT = int(os.environ.get("PORT", 3000))
PUBLIC = Path(__file__).parent / "public"

rooms: dict[str, set[web.WebSocketResponse]] = {}


def get_room(room_id: str) -> set:
    if room_id not in rooms:
        rooms[room_id] = set()
    return rooms[room_id]


async def broadcast(room_id: str, message: dict, exclude=None):
    room = rooms.get(room_id)
    if not room:
        return
    data = json.dumps(message)
    dead = []
    for client in room:
        if client is exclude:
            continue
        try:
            await client.send_str(data)
        except Exception:
            dead.append(client)
    for client in dead:
        room.discard(client)


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    room_id = None
    try:
        async for msg in ws:
            if msg.type != web.WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            if msg_type == "join":
                room_id = data.get("roomId", "").upper()
                room = get_room(room_id)
                room.add(ws)
                peers = len(room) - 1
                await ws.send_str(json.dumps({"type": "joined", "peers": peers, "roomId": room_id}))
                if peers > 0:
                    await broadcast(room_id, {"type": "peer-joined"}, exclude=ws)

            elif msg_type in ("offer", "answer", "ice-candidate", "screen-share", "draw", "draw-clear") and room_id:
                await broadcast(room_id, data, exclude=ws)

            elif msg_type == "leave":
                break
    finally:
        if room_id and room_id in rooms:
            rooms[room_id].discard(ws)
            await broadcast(room_id, {"type": "peer-left"})
            if not rooms[room_id]:
                del rooms[room_id]

    return ws


async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(PUBLIC / "index.html")


def file_route(filename: str):
    async def handler(request: web.Request) -> web.FileResponse:
        return web.FileResponse(PUBLIC / filename)
    return handler


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/ws", websocket_handler)
    app.router.add_get("/", index)
    app.router.add_get("/styles.css", file_route("styles.css"))
    app.router.add_get("/app.js", file_route("app.js"))
    return app


if __name__ == "__main__":
    print(f"Video Call server running at http://localhost:{PORT}")
    web.run_app(create_app(), host="0.0.0.0", port=PORT, print=None)
