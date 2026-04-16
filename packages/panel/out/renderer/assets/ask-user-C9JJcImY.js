import { a as createRoot, j as jsxRuntimeExports, r as reactExports } from "./client-CTCutEjw.js";
const bridge = window.askUserBridge;
function AskUserApp() {
  const [request, setRequest] = reactExports.useState(null);
  const [remaining, setRemaining] = reactExports.useState(120);
  const [selectedSingle, setSelectedSingle] = reactExports.useState("");
  const [selectedMulti, setSelectedMulti] = reactExports.useState(/* @__PURE__ */ new Set());
  const [inputValue, setInputValue] = reactExports.useState("");
  const [noteValue, setNoteValue] = reactExports.useState("");
  const timerRef = reactExports.useRef(null);
  reactExports.useEffect(() => {
    bridge.onShowRequest((req) => {
      setRequest(req);
      setRemaining(Math.ceil(req.timeout_ms / 1e3));
      if (req.options?.length) {
        setSelectedSingle(req.options[0]);
      }
    });
    bridge.getRequest().then((req) => {
      if (req) {
        setRequest(req);
        setRemaining(Math.ceil(req.timeout_ms / 1e3));
        if (req.options?.length) {
          setSelectedSingle(req.options[0]);
        }
      }
    });
  }, []);
  reactExports.useEffect(() => {
    if (!request) return;
    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1e3);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [request]);
  const handleSubmit = reactExports.useCallback(() => {
    if (!request) return;
    const response = {};
    switch (request.type) {
      case "confirm":
        response.choice = "confirmed";
        break;
      case "single_choice":
        response.choice = selectedSingle;
        break;
      case "multi_choice":
        response.choice = Array.from(selectedMulti);
        break;
      case "input":
        response.input = inputValue;
        break;
    }
    if (noteValue.trim()) {
      response.input = response.input ? `${response.input}
---
${noteValue.trim()}` : noteValue.trim();
    }
    bridge.submitResponse(request.id, response);
  }, [request, selectedSingle, selectedMulti, inputValue, noteValue]);
  const handleReject = reactExports.useCallback(() => {
    if (!request) return;
    if (request.type === "confirm") {
      bridge.submitResponse(request.id, { choice: "rejected", input: noteValue.trim() || void 0 });
    } else {
      bridge.cancel(request.id);
    }
  }, [request, noteValue]);
  if (!request) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ask-user-container", children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ask-user-card", children: /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "ask-user-loading", children: "Loading..." }) }) });
  }
  const timerColor = remaining <= 10 ? "#ef4444" : remaining <= 30 ? "#f59e0b" : "#6b7280";
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ask-user-container", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ask-user-card", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ask-user-header", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ask-user-header-left", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ask-user-member-badge", children: request.member_name }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ask-user-title", children: request.title })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "ask-user-timer", style: { color: timerColor }, children: [
        remaining,
        "s"
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ask-user-body", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "ask-user-question", children: request.question }),
      request.type === "single_choice" && request.options && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ask-user-options", children: request.options.map((opt) => /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "ask-user-option-label", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            type: "radio",
            name: "single_choice",
            value: opt,
            checked: selectedSingle === opt,
            onChange: () => setSelectedSingle(opt),
            className: "ask-user-radio"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ask-user-option-text", children: opt })
      ] }, opt)) }),
      request.type === "multi_choice" && request.options && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ask-user-options", children: request.options.map((opt) => /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "ask-user-option-label", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            type: "checkbox",
            checked: selectedMulti.has(opt),
            onChange: () => {
              setSelectedMulti((prev) => {
                const next = new Set(prev);
                if (next.has(opt)) next.delete(opt);
                else next.add(opt);
                return next;
              });
            },
            className: "ask-user-checkbox"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ask-user-option-text", children: opt })
      ] }, opt)) }),
      request.type === "input" && /* @__PURE__ */ jsxRuntimeExports.jsx(
        "textarea",
        {
          className: "ask-user-textarea",
          value: inputValue,
          onChange: (e) => setInputValue(e.target.value),
          placeholder: "Enter your response...",
          autoFocus: true
        }
      ),
      request.type !== "input" && /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          type: "text",
          className: "ask-user-note-input",
          value: noteValue,
          onChange: (e) => setNoteValue(e.target.value),
          placeholder: "Optional note..."
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ask-user-actions", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "ask-user-btn-reject", onClick: handleReject, children: request.type === "confirm" ? "Reject" : "Cancel" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "ask-user-btn-confirm", onClick: handleSubmit, children: request.type === "confirm" ? "Confirm" : "Submit" })
    ] })
  ] }) });
}
const root = createRoot(document.getElementById("root"));
root.render(/* @__PURE__ */ jsxRuntimeExports.jsx(AskUserApp, {}));
