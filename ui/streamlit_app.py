import json
import os
import time
from typing import Any, Dict, Generator, List, Optional, Tuple

import requests
import streamlit as st

DEFAULT_AGENT_BASE_URL = os.getenv("AGENT_BASE_URL", "http://localhost:8080")
DEFAULT_TIMEOUT_SECONDS = int(os.getenv("AGENT_REQUEST_TIMEOUT_SECONDS", "120"))


def main() -> None:
    st.set_page_config(page_title="Agent Console", page_icon=":robot_face:", layout="wide")
    inject_styles()
    init_state()

    st.title("Agent Console")
    st.caption("Streamlit interface for the MCP + Skills agent service")

    sidebar = st.sidebar
    sidebar.header("Connection")
    base_url = sidebar.text_input("Agent Base URL", value=st.session_state["base_url"]).strip()
    timeout_seconds = int(
        sidebar.number_input(
            "HTTP Timeout (seconds)", min_value=5, max_value=600, value=st.session_state["timeout_seconds"]
        )
    )

    sidebar.header("Conversation")
    session_id = sidebar.text_input("Session ID", value=st.session_state["session_id"]).strip()
    user_id = sidebar.text_input("User ID", value=st.session_state["user_id"]).strip()
    skill_names_csv = sidebar.text_input(
        "Skill Names (comma-separated)", value=st.session_state["skill_names_csv"]
    )
    mode = sidebar.radio("Chat Mode", options=["stream", "sync", "async"], index=0, horizontal=True)

    sidebar.header("Advanced Payload")
    metadata_text = sidebar.text_area(
        "Metadata JSON",
        value=st.session_state["metadata_text"],
        height=90,
        help='Example: {"tenant":"alpha"}',
    )
    tool_choice_text = sidebar.text_area(
        "Tool Choice JSON",
        value=st.session_state["tool_choice_text"],
        height=90,
        help='Optional. Example: {"type":"auto"}',
    )

    if sidebar.button("Save Sidebar Settings", use_container_width=True):
        st.session_state["base_url"] = base_url
        st.session_state["timeout_seconds"] = timeout_seconds
        st.session_state["session_id"] = session_id
        st.session_state["user_id"] = user_id
        st.session_state["skill_names_csv"] = skill_names_csv
        st.session_state["metadata_text"] = metadata_text
        st.session_state["tool_choice_text"] = tool_choice_text
        st.success("Saved settings.")

    if sidebar.button("Clear Chat History", use_container_width=True):
        st.session_state["messages"] = []
        st.success("Cleared chat history.")

    metadata_value, metadata_error = parse_optional_json(metadata_text, "Metadata JSON")
    tool_choice_value, tool_choice_error = parse_optional_json(tool_choice_text, "Tool Choice JSON")

    for error in [metadata_error, tool_choice_error]:
        if error:
            st.error(error)

    tabs = st.tabs(["Chat", "Chain", "Memory", "Inspect"])

    with tabs[0]:
        render_chat_tab(
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            mode=mode,
            session_id=session_id,
            user_id=user_id,
            skill_names=parse_csv(skill_names_csv),
            metadata_value=metadata_value,
            tool_choice_value=tool_choice_value,
        )

    with tabs[1]:
        render_chain_tab(
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            session_id=session_id,
            user_id=user_id,
            metadata_value=metadata_value,
            tool_choice_value=tool_choice_value,
        )

    with tabs[2]:
        render_memory_tab(
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            session_id=session_id,
            user_id=user_id,
        )

    with tabs[3]:
        render_inspect_tab(base_url=base_url, timeout_seconds=timeout_seconds)


def render_chat_tab(
    *,
    base_url: str,
    timeout_seconds: int,
    mode: str,
    session_id: str,
    user_id: str,
    skill_names: List[str],
    metadata_value: Optional[Dict[str, Any]],
    tool_choice_value: Optional[Dict[str, Any]],
) -> None:
    st.subheader("Chat")

    for message in st.session_state["messages"]:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])

    prompt = st.chat_input("Message the agent")
    if not prompt:
        return

    st.session_state["messages"].append({"role": "user", "content": prompt})
    with st.chat_message("user"):
        st.markdown(prompt)

    payload: Dict[str, Any] = {
        "input": prompt,
        "sessionId": session_id or None,
        "userId": user_id or None,
        "skillNames": skill_names or None,
        "metadata": metadata_value,
        "toolChoice": tool_choice_value,
    }
    payload = prune_none(payload)

    with st.chat_message("assistant"):
        if mode == "sync":
            response, error = post_json(base_url, "/v1/chat", payload, timeout_seconds)
            if error:
                st.error(error)
                st.session_state["messages"].append({"role": "assistant", "content": f"Error: {error}"})
                return

            output_text = str(response.get("outputText", ""))
            st.markdown(output_text or "(No output text)")
            st.session_state["messages"].append({"role": "assistant", "content": output_text or "(No output text)"})
            st.caption(f"responseId: {response.get('responseId', 'n/a')}")
            return

        if mode == "async":
            response, error = post_json(base_url, "/v1/chat/async", payload, timeout_seconds)
            if error:
                st.error(error)
                st.session_state["messages"].append({"role": "assistant", "content": f"Error: {error}"})
                return

            response_id = str(response.get("responseId", ""))
            if not response_id:
                st.error("Async request succeeded but no responseId was returned.")
                return

            st.info(f"Queued async response: {response_id}")
            auto_poll = st.checkbox("Auto-poll status", value=True)
            if auto_poll:
                final_text = poll_async_response(base_url, response_id, timeout_seconds)
                st.session_state["messages"].append({"role": "assistant", "content": final_text})
            return

        # Streaming mode
        placeholder = st.empty()
        accumulated = ""
        stream_error: Optional[str] = None

        for event in stream_events(base_url, "/v1/chat/stream", payload, timeout_seconds):
            event_type = event.get("type")
            if event_type == "delta":
                delta = str(event.get("delta", ""))
                accumulated += delta
                placeholder.markdown(accumulated)
            elif event_type == "done":
                final_text = str(event.get("outputText", ""))
                if final_text and len(final_text) > len(accumulated):
                    accumulated = final_text
                    placeholder.markdown(accumulated)
                st.caption(f"responseId: {event.get('responseId', 'n/a')}")
            elif event_type == "error":
                stream_error = str(event.get("error", "Unknown stream error"))
                break

        if stream_error:
            st.error(stream_error)
            st.session_state["messages"].append({"role": "assistant", "content": f"Error: {stream_error}"})
            return

        final_text = accumulated or "(No output text)"
        placeholder.markdown(final_text)
        st.session_state["messages"].append({"role": "assistant", "content": final_text})


def render_chain_tab(
    *,
    base_url: str,
    timeout_seconds: int,
    session_id: str,
    user_id: str,
    metadata_value: Optional[Dict[str, Any]],
    tool_choice_value: Optional[Dict[str, Any]],
) -> None:
    st.subheader("Skill Chain")
    st.caption("Run planner -> skill steps -> summary via /v1/chat/chain")

    with st.form("chain-form"):
        input_text = st.text_area("Task", height=120, placeholder="Describe the task you want to execute.")
        skill_chain_csv = st.text_input("Skill Chain (comma-separated)", value="summarizer")
        planner_hint = st.text_input("Planner Hint (optional)")
        summarizer_hint = st.text_input("Summarizer Hint (optional)")
        submitted = st.form_submit_button("Run Chain", use_container_width=True)

    if not submitted:
        return

    if not input_text.strip():
        st.error("Task is required.")
        return

    skill_chain = parse_csv(skill_chain_csv)
    if not skill_chain:
        st.error("At least one skill is required in Skill Chain.")
        return

    payload = prune_none(
        {
            "input": input_text.strip(),
            "sessionId": session_id or None,
            "userId": user_id or None,
            "skillChain": skill_chain,
            "plannerHint": planner_hint.strip() or None,
            "summarizerHint": summarizer_hint.strip() or None,
            "metadata": metadata_value,
            "toolChoice": tool_choice_value,
        }
    )

    response, error = post_json(base_url, "/v1/chat/chain", payload, timeout_seconds)
    if error:
        st.error(error)
        return

    st.success("Chain completed.")
    plan = response.get("plan", {})
    st.markdown("### Plan")
    st.write(plan)

    steps = response.get("steps", [])
    st.markdown("### Step Outputs")
    if isinstance(steps, list):
        for index, step in enumerate(steps, start=1):
            st.markdown(f"#### Step {index}: {step.get('skill', 'unknown')}")
            st.caption(f"Objective: {step.get('objective', '')}")
            st.code(str(step.get("outputText", "")), language="markdown")
    else:
        st.write(steps)

    st.markdown("### Final")
    final = response.get("final", {})
    st.markdown(str(final.get("outputText", "")))
    st.caption(f"responseId: {final.get('responseId', 'n/a')}")


def render_memory_tab(*, base_url: str, timeout_seconds: int, session_id: str, user_id: str) -> None:
    st.subheader("Memory")

    col_left, col_right = st.columns(2)

    with col_left:
        st.markdown("### Add Feedback Memory")
        with st.form("memory-feedback-form"):
            content = st.text_area("Memory Content", placeholder="Example: Avoid using corporate jargon.")
            category = st.text_input("Category", value="style")
            source = st.text_input("Source", value="streamlit-ui")
            save_clicked = st.form_submit_button("Save Memory", use_container_width=True)

        if save_clicked:
            if not content.strip():
                st.error("Memory Content is required.")
            else:
                payload = prune_none(
                    {
                        "content": content.strip(),
                        "category": category.strip() or None,
                        "source": source.strip() or None,
                        "sessionId": session_id or None,
                        "userId": user_id or None,
                    }
                )
                response, error = post_json(base_url, "/v1/memory/feedback", payload, timeout_seconds)
                if error:
                    st.error(error)
                else:
                    st.success("Memory saved.")
                    st.json(response)

    with col_right:
        st.markdown("### Browse Memory")
        limit = st.number_input("Limit", min_value=1, max_value=100, value=20)
        if st.button("Refresh Memory", use_container_width=True):
            params = prune_none({"sessionId": session_id or None, "userId": user_id or None, "limit": int(limit)})
            response, error = get_json(base_url, "/v1/memory", params, timeout_seconds)
            if error:
                st.error(error)
            else:
                st.json(response)


def render_inspect_tab(*, base_url: str, timeout_seconds: int) -> None:
    st.subheader("Inspect Service")
    st.caption("Quick checks for health, context, MCP, and skills")

    endpoints = [
        ("Health", "/healthz"),
        ("Context", "/v1/context"),
        ("MCP Servers", "/v1/mcp/servers"),
        ("Local Skills", "/v1/skills/local"),
    ]

    cols = st.columns(len(endpoints))
    for idx, (label, _) in enumerate(endpoints):
        with cols[idx]:
            if st.button(label, use_container_width=True):
                st.session_state["inspect_endpoint"] = endpoints[idx][1]

    endpoint = st.session_state.get("inspect_endpoint")
    if endpoint:
        response, error = get_json(base_url, endpoint, params=None, timeout_seconds=timeout_seconds)
        st.markdown(f"### GET {endpoint}")
        if error:
            st.error(error)
        else:
            st.json(response)


def post_json(base_url: str, path: str, payload: Dict[str, Any], timeout_seconds: int) -> Tuple[Dict[str, Any], Optional[str]]:
    url = build_url(base_url, path)
    try:
        response = requests.post(url, json=payload, timeout=timeout_seconds)
    except requests.RequestException as exc:
        return {}, str(exc)

    body = parse_json_response(response)
    if response.ok:
        return body, None

    return {}, format_http_error(response.status_code, body)


def get_json(
    base_url: str,
    path: str,
    params: Optional[Dict[str, Any]],
    timeout_seconds: int,
) -> Tuple[Dict[str, Any], Optional[str]]:
    url = build_url(base_url, path)
    try:
        response = requests.get(url, params=params, timeout=timeout_seconds)
    except requests.RequestException as exc:
        return {}, str(exc)

    body = parse_json_response(response)
    if response.ok:
        return body, None

    return {}, format_http_error(response.status_code, body)


def stream_events(
    base_url: str,
    path: str,
    payload: Dict[str, Any],
    timeout_seconds: int,
) -> Generator[Dict[str, Any], None, None]:
    url = build_url(base_url, path)

    try:
        with requests.post(url, json=payload, timeout=timeout_seconds, stream=True) as response:
            if response.status_code >= 400:
                body = parse_json_response(response)
                yield {"type": "error", "error": format_http_error(response.status_code, body)}
                return

            for raw_line in response.iter_lines(decode_unicode=True):
                if not raw_line:
                    continue
                if not raw_line.startswith("data: "):
                    continue

                data_chunk = raw_line[6:]
                try:
                    event = json.loads(data_chunk)
                except json.JSONDecodeError:
                    yield {"type": "error", "error": f"Invalid stream event: {data_chunk}"}
                    return

                if isinstance(event, dict):
                    yield event
                else:
                    yield {"type": "error", "error": f"Unexpected stream payload: {event}"}
                    return
    except requests.RequestException as exc:
        yield {"type": "error", "error": str(exc)}


def poll_async_response(base_url: str, response_id: str, timeout_seconds: int) -> str:
    status_placeholder = st.empty()
    output_placeholder = st.empty()

    max_attempts = 30
    poll_delay_seconds = 2

    for attempt in range(1, max_attempts + 1):
        response, error = get_json(
            base_url,
            f"/v1/chat/status/{response_id}",
            params=None,
            timeout_seconds=timeout_seconds,
        )
        if error:
            status_placeholder.error(error)
            return f"Error: {error}"

        status = str(response.get("status", "unknown"))
        status_placeholder.info(f"Polling {response_id}: attempt {attempt}/{max_attempts}, status={status}")

        if status in {"completed", "failed", "incomplete", "cancelled"}:
            output_text = str(response.get("outputText", "")) or f"Final status: {status}"
            output_placeholder.markdown(output_text)
            return output_text

        time.sleep(poll_delay_seconds)

    timeout_message = f"Timed out waiting for async completion: {response_id}"
    status_placeholder.warning(timeout_message)
    return timeout_message


def parse_optional_json(raw_value: str, label: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    value = raw_value.strip()
    if not value:
        return None, None

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        return None, f"{label} is not valid JSON: {exc}"

    if not isinstance(parsed, dict):
        return None, f"{label} must be a JSON object."

    return parsed, None


def parse_csv(raw_value: str) -> List[str]:
    return [item.strip() for item in raw_value.split(",") if item.strip()]


def parse_json_response(response: requests.Response) -> Dict[str, Any]:
    try:
        parsed = response.json()
        return parsed if isinstance(parsed, dict) else {"data": parsed}
    except ValueError:
        text = response.text.strip()
        return {"raw": text or "<empty response>"}


def format_http_error(status_code: int, body: Dict[str, Any]) -> str:
    return f"HTTP {status_code}: {json.dumps(body, ensure_ascii=True)}"


def build_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}{path}"


def prune_none(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


def init_state() -> None:
    st.session_state.setdefault("base_url", DEFAULT_AGENT_BASE_URL)
    st.session_state.setdefault("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
    st.session_state.setdefault("session_id", "demo-session")
    st.session_state.setdefault("user_id", "demo-user")
    st.session_state.setdefault("skill_names_csv", "summarizer")
    st.session_state.setdefault("metadata_text", "")
    st.session_state.setdefault("tool_choice_text", "")
    st.session_state.setdefault("messages", [])


def inject_styles() -> None:
    st.markdown(
        """
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&display=swap');
          html, body, [class*="css"]  {
            font-family: 'Manrope', sans-serif;
          }
          .stApp {
            background: linear-gradient(120deg, #f8fafc 0%, #eef2ff 45%, #ecfeff 100%);
          }
          section[data-testid="stSidebar"] {
            background: linear-gradient(180deg, #0f172a 0%, #1e293b 100%);
          }
          section[data-testid="stSidebar"] * {
            color: #e2e8f0;
          }
        </style>
        """,
        unsafe_allow_html=True,
    )


if __name__ == "__main__":
    main()
