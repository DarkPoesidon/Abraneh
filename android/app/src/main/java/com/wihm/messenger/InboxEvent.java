package com.wihm.messenger;

import org.json.JSONException;
import org.json.JSONObject;

/** One event from the server's per-user inbox socket. */
final class InboxEvent {
    enum Kind { CALL, CALL_END, MESSAGE }

    final Kind kind;
    final String chatId;
    final String callId;
    final String messageId;
    final String title;
    final String body;
    final String caller;
    final boolean video;

    private InboxEvent(Kind kind, JSONObject json) {
        this.kind = kind;
        chatId = json.optString("chatId");
        callId = json.optString("callId");
        messageId = json.optString("messageId");
        title = json.optString("title");
        body = json.optString("body");
        caller = json.optString("caller");
        video = json.optBoolean("video");
    }

    /** Returns null for anything malformed, because a bad event must never stop the socket. */
    static InboxEvent parse(String text) {
        try {
            JSONObject json = new JSONObject(text);
            String kind = json.optString("kind");
            Kind parsed = "call".equals(kind) ? Kind.CALL : "call-end".equals(kind) ? Kind.CALL_END : Kind.MESSAGE;
            InboxEvent event = new InboxEvent(parsed, json);
            if (parsed != Kind.MESSAGE && event.callId.isEmpty()) return null;
            if (parsed == Kind.CALL && !UrlRules.isChatId(event.chatId)) return null;
            if (parsed == Kind.MESSAGE && event.title.isEmpty()) return null;
            return event;
        } catch (JSONException e) {
            return null;
        }
    }
}
