// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Array<{ root: Root; element: HTMLElement }> = [];
const render = (content: ReactNode) => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push({ root, element });
  act(() => root.render(content));
  return { rerender: (next: ReactNode) => act(() => root.render(next)) };
};
const cleanup = () => {
  for (const { root, element } of roots.splice(0)) {
    act(() => root.unmount());
    element.remove();
  }
};
const screen = {
  getByLabelText: (label: string) =>
    document.querySelector(`[aria-label="${label}"]`)!,
};
const fireEvent = {
  change: (element: Element, event: { target: { value: string } }) =>
    act(() => {
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        event.target.value,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }),
};
import { ValueCombobox, parseChipValue } from "../packages/ui/value-combobox";
import { FieldInput } from "../packages/ui/fields";
import { field, decodeField } from "@jocki/platform/field-types";
import { EditorView } from "@codemirror/view";
afterEach(cleanup);
it("updates Markdown from synced values and rollbacks without remounting or emitting edits, and blocks read-only widget writes", () => {
  const definition = field("notes", "Notes", "text", { control: "markdown" });
  const change = vi.fn();
  const editor = (value: string, disabled = false) => (
    <FieldInput
      definition={definition}
      value={value}
      onChange={change}
      disabled={disabled}
    />
  );
  const { rerender } = render(editor("**Saved**"));
  const content = screen.getByLabelText("Notes") as HTMLElement;
  const view = EditorView.findFromDOM(content)!;
  act(() =>
    view.dispatch({
      changes: { from: view.state.doc.length, insert: " draft" },
    }),
  );
  expect(change).toHaveBeenLastCalledWith("**Saved** draft");
  rerender(editor("**Saved** draft"));
  expect(screen.getByLabelText("Notes")).toBe(content);
  change.mockClear();
  rerender(editor("# Synced remotely"));
  expect(view.state.doc.toString()).toBe("# Synced remotely");
  expect(change).not.toHaveBeenCalled();
  rerender(editor("- [ ] Locked", true));
  expect(content.getAttribute("contenteditable")).toBe("false");
  act(() => view.dispatch({ changes: { from: 3, to: 4, insert: "x" } }));
  expect(view.state.doc.toString()).toBe("- [ ] Locked");
  expect(change).not.toHaveBeenCalled();
  rerender(editor("Restored"));
  expect(view.state.doc.toString()).toBe("Restored");
  expect(screen.getByLabelText("Notes")).toBe(content);
});
it("keeps exact decimal and bigint inputs intact in the shared editor", () => {
  const amount = field("amount", "Amount", "numeric", {
    precision: 38,
    scale: 6,
  });
  const change = vi.fn();
  render(<FieldInput definition={amount} value={null} onChange={change} />);
  const exact = "12345678901234567890.123456";
  fireEvent.change(screen.getByLabelText("Amount"), {
    target: { value: exact },
  });
  expect(change).toHaveBeenLastCalledWith(exact);
  expect(decodeField(amount, change.mock.calls[0][0])).toBe(exact);
  cleanup();
  const count = field("count", "Count", "bigint");
  render(<FieldInput definition={count} value={null} onChange={change} />);
  fireEvent.change(screen.getByLabelText("Count"), {
    target: { value: "9007199254740993" },
  });
  expect(change).toHaveBeenLastCalledWith("9007199254740993");
});
it("marks invalid JSON as an unsaved draft and prevents native validity from passing", () => {
  const change = vi.fn(),
    dirty = vi.fn();
  const { rerender } = render(
    <FieldInput
      definition={field("json", "JSON", "jsonb")}
      value={{ saved: true }}
      onChange={change}
      onDraftChange={dirty}
    />,
  );
  const input = screen.getByLabelText("JSON") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '{"broken":' } });
  expect(dirty).toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  expect(input.checkValidity()).toBe(false);
  rerender(
    <FieldInput
      definition={field("json", "JSON", "jsonb")}
      value={{ restored: true }}
      onChange={change}
    />,
  );
  expect(input.checkValidity()).toBe(true);
  expect(input.value).toContain('"restored"');
});
it("disables view-only controls and reflects replacement array values in chips", () => {
  const change = vi.fn();
  render(
    <FieldInput
      definition={field("locked", "Locked", "text", { visibility: "viewable" })}
      value="Read only"
      onChange={change}
    />,
  );
  expect((screen.getByLabelText("Locked") as HTMLInputElement).disabled).toBe(
    true,
  );
  cleanup();
  const definition = field("scores", "Scores", "integer", {
    array: true,
    inputMode: "list",
  });
  const { rerender } = render(
    <FieldInput definition={definition} value={[1, 2]} onChange={change} />,
  );
  expect(
    [...document.querySelectorAll('[data-slot="combobox-chip"]')].map(
      (el) => el.textContent,
    ),
  ).toEqual(["1", "2"]);
  fireEvent.change(screen.getByLabelText("Scores"), { target: { value: "7" } });
  expect(
    (screen.getByLabelText("Scores") as HTMLInputElement).checkValidity(),
  ).toBe(false);
  rerender(
    <FieldInput
      definition={definition}
      value={[4, 5]}
      onChange={change}
      disabled
    />,
  );
  expect(
    [...document.querySelectorAll('[data-slot="combobox-chip"]')].map(
      (el) => el.textContent,
    ),
  ).toEqual(["4", "5"]);
  expect((screen.getByLabelText("Scores") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Scores") as HTMLInputElement).disabled).toBe(
    true,
  );
});

it("parses created chips using the shared scalar contract without losing types or precision", () => {
  expect(parseChipValue(field("n", "Number", "integer"), "42")).toBe(42);
  expect(parseChipValue(field("b", "Boolean", "boolean"), "false")).toBe(false);
  expect(
    parseChipValue(field("j", "JSON", "jsonb"), '{"values":[1,true]}'),
  ).toEqual({ values: [1, true] });
  expect(parseChipValue(field("s", "Text", "text"), "001")).toBe("001");
  expect(
    parseChipValue(field("n", "Number", "bigint"), "9007199254740993"),
  ).toBe("9007199254740993");
  expect(
    parseChipValue(
      field("n", "Number", "numeric", { precision: 38, scale: 6 }),
      "12345678901234567890.123456",
    ),
  ).toBe("12345678901234567890.123456");
  expect(() =>
    parseChipValue(field("n", "Number", "integer"), "1.5"),
  ).toThrow();
  expect(() =>
    parseChipValue(field("n", "Number", "integer"), "wrong"),
  ).toThrow();
  expect(() =>
    parseChipValue(field("b", "Boolean", "boolean"), "yes"),
  ).toThrow();
  expect(() => parseChipValue(field("j", "JSON", "jsonb"), "null")).toThrow();
});

it("allows replacing fixed-count selections while blocking an incomplete save", () => {
  function Editor() {
    const [value, setValue] = useState<any[]>(["first"]);
    return (
      <form>
        <ValueCombobox
          label="Fixed choice"
          name="choice"
          value={value}
          onChange={setValue}
          options={[
            { value: "first", label: "First" },
            { value: "second", label: "Second" },
          ]}
          minItems={1}
          maxItems={1}
        />
      </form>
    );
  }
  render(<Editor />);
  const form = document.querySelector("form")!;
  expect(new FormData(form).getAll("choice")).toEqual(["first"]);
  expect(form.checkValidity()).toBe(true);
  act(() =>
    document
      .querySelector<HTMLButtonElement>('[data-slot="combobox-chip-remove"]')!
      .click(),
  );
  expect(document.querySelectorAll('[data-slot="combobox-chip"]')).toHaveLength(
    0,
  );
  expect(form.checkValidity()).toBe(false);
});
