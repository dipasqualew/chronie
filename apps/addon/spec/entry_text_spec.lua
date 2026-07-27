local loader = require("addon_loader")

---The sanitiser is the narrowest thing in the addon and the one with the most readers behind
---it: a note leaves here for a Lua file the client writes, a hand-written Rust reader, a SQLite
---row and a React tree, and one bad byte spoils the whole file rather than the one note. So the
---rules are asserted one at a time and by example, because "no control characters" and "no pipe
---survives" are invariants somebody downstream is entitled to rely on rather than preferences.
describe("ns.entryText", function()
    local ns = loader.load()

    it("is exported by the addon files", function()
        assert.is_function(ns.entryText)
    end)

    -- One cap, in one place, so the edit box and the store cannot disagree about it.
    it("publishes the cap it holds text to", function()
        assert.equal(512, ns.ENTRY_TEXT_MAX_BYTES)
    end)

    -- Nil rather than "" for every one of these, which is what lets a caller treat "they
    -- submitted nothing" and "they submitted spaces and a colour code" as the one thing they
    -- are: a note nobody wrote.
    describe("a note nobody wrote", function()
        for _, case in ipairs({
            { label = "nothing at all", raw = nil },
            { label = "a number the client handed over", raw = 42 },
            { label = "a table", raw = {} },
            { label = "a boolean", raw = true },
            { label = "the empty string", raw = "" },
            { label = "spaces", raw = "     " },
            { label = "a tab and a newline", raw = "\t\n" },
            { label = "a pipe on its own", raw = "|" },
            { label = "a row of pipes", raw = "||||" },
            { label = "a texture on its own", raw = "|TInterface\\Icons\\foo:16|t" },
            { label = "an atlas on its own", raw = "|Aatlas:thing:16:16|a" },
            { label = "a hyperlink with an empty label", raw = "|Hitem:19019|h|h" },
        }) do
            it("answers nothing for " .. case.label, function()
                assert.is_nil(ns.entryText(case.raw))
            end)
        end
    end)

    -- A newline out of a paste ends the string as far as anything reading a line at a time is
    -- concerned, which is most of what will read this note.
    describe("whitespace and control characters", function()
        for _, case in ipairs({
            { label = "a newline", raw = "two\nlines", text = "two lines" },
            { label = "a tab", raw = "two\tlines", text = "two lines" },
            { label = "a carriage return", raw = "two\rlines", text = "two lines" },
            { label = "a CRLF pair", raw = "two\r\nlines", text = "two lines" },
            { label = "a NUL byte", raw = "two\0lines", text = "two lines" },
            { label = "a bell", raw = "two\alines", text = "two lines" },
            { label = "a run of spaces", raw = "two    lines", text = "two lines" },
            { label = "a run of mixed whitespace", raw = "two \t\n lines", text = "two lines" },
            { label = "leading whitespace", raw = "  two lines", text = "two lines" },
            { label = "trailing whitespace", raw = "two lines \n", text = "two lines" },
            { label = "padding on both ends", raw = "\t two lines \t", text = "two lines" },
        }) do
            it("folds " .. case.label .. " into one line", function()
                assert.equal(case.text, ns.entryText(case.raw))
            end)
        end
    end)

    -- The deliberate decision the escape sequences deserve, made here rather than at each of
    -- the four places the text is read: "a stored note holds no pipe" is an invariant every
    -- reader downstream gets for free.
    describe("the client's escape sequences", function()
        for _, case in ipairs({
            {
                label = "keeps the coloured words and drops the colour",
                raw = "|cffff0000red|r",
                -- The `r` of `|r` survives: what is stripped is the pipe, and what follows it
                -- is text. The desktop side's `note_text` does exactly the same thing, and
                -- that agreement is the whole reason both are spelled out.
                text = "redr",
            },
            {
                label = "leaves the r of a colour reset behind when there was nothing else",
                raw = "|cffff0000|r",
                text = "r",
            },
            {
                label = "keeps the readable half of a hyperlink",
                raw = "|Hitem:19019::::::::60:::::|h[Thunderfury]|h",
                text = "[Thunderfury]",
            },
            {
                label = "unwraps a link the client coloured for its quality",
                raw = "got |cffa335ee|Hitem:19019::::::::60:::::|h[Thunderfury]|h|r tonight",
                text = "got [Thunderfury]r tonight",
            },
            {
                label = "removes a texture",
                raw = "|TInterface\\Icons\\foo:16|t look at this",
                text = "look at this",
            },
            {
                label = "removes an atlas",
                raw = "|Aatlas:thing:16:16|a look at this",
                text = "look at this",
            },
            {
                label = "removes a pipe a player typed themselves",
                raw = "Thrall | Ragnaros",
                text = "Thrall Ragnaros",
            },
            {
                label = "removes a doubled pipe",
                raw = "a || b",
                text = "a b",
            },
            {
                label = "removes a newline escape",
                raw = "one|ntwo",
                text = "onentwo",
            },
            {
                label = "keeps the rest of a colour code that never closed",
                -- Six hex digits rather than eight, so the colour pattern does not match and
                -- only the pipe goes. An escape somebody typed half of is text, not a licence
                -- to eat the rest of the sentence.
                raw = "|cffff00 nonsense",
                text = "cffff00 nonsense",
            },
            {
                label = "keeps the rest of a link that never closed",
                raw = "|Hitem:19019|h[Thunderfury] and more",
                text = "Hitem:19019h[Thunderfury] and more",
            },
            {
                label = "keeps the rest of a texture that never closed",
                raw = "|Tno end of it",
                text = "Tno end of it",
            },
        }) do
            it(case.label, function()
                assert.equal(case.text, ns.entryText(case.raw))
            end)
        end

        -- The invariant, said as an invariant rather than as a list of examples.
        it("lets no pipe through, whatever shape it arrived in", function()
            for _, raw in ipairs({
                "|cffff0000red|r",
                "|Hitem:19019::::::::60:::::|h[Thunderfury]|h",
                "|TInterface\\Icons\\foo:16|t",
                "|Aatlas:thing:16:16|a x",
                "a | b",
                "||||",
                "|c",
                "trailing pipe |",
            }) do
                local text = ns.entryText(raw)
                if text then
                    assert.is_nil(text:find("|", 1, true), "a pipe survived " .. raw)
                end
            end
        end)
    end)

    -- Sanitising is not escaping. The markup a player types is theirs and reaches the store
    -- verbatim; the desktop side escapes it at the one place it builds HTML out of a string.
    describe("markup a player typed", function()
        for _, raw in ipairs({
            "<b>bold</b>",
            "<script>alert(1)</script>",
            "a & b",
            'he said "hello"',
            "1 < 2 > 0",
        }) do
            it("leaves " .. raw .. " exactly as it was typed", function()
                assert.equal(raw, ns.entryText(raw))
            end)
        end
    end)

    describe("the cap", function()
        it("leaves a sentence shorter than the cap alone", function()
            local raw = "the sun coming up over Nagrand"

            assert.equal(raw, ns.entryText(raw))
        end)

        it("cuts ASCII to exactly the cap", function()
            local text = ns.entryText(string.rep("a", ns.ENTRY_TEXT_MAX_BYTES + 200))

            assert.equal(ns.ENTRY_TEXT_MAX_BYTES, #text)
            assert.equal(string.rep("a", ns.ENTRY_TEXT_MAX_BYTES), text)
        end)

        it("leaves a string exactly the length of the cap untouched", function()
            local raw = string.rep("a", ns.ENTRY_TEXT_MAX_BYTES)

            assert.equal(raw, ns.entryText(raw))
        end)

        -- Half of a multi-byte character is invalid UTF-8, and invalid UTF-8 fails the whole
        -- sync rather than this one row. Both widths are exercised, because a two-byte
        -- character can only ever be split one way and a three-byte one two ways.
        describe("cutting on a character boundary", function()
            ---A byte in the middle of a UTF-8 character: 10xxxxxx.
            ---@param byte integer?
            ---@return boolean
            local function isContinuation(byte)
                return byte ~= nil and byte >= 0x80 and byte < 0xC0
            end

            ---Every character in `text` is whole: no continuation byte follows the end of it,
            ---and the last byte is not itself the opening half of one.
            ---@param text string
            local function isWholeUtf8(text)
                local index = 1
                while index <= #text do
                    local byte = text:byte(index)
                    local width = 1
                    if byte >= 0xF0 then
                        width = 4
                    elseif byte >= 0xE0 then
                        width = 3
                    elseif byte >= 0xC0 then
                        width = 2
                    end
                    assert.is_false(isContinuation(byte), "a continuation byte started a character")
                    for offset = 1, width - 1 do
                        assert.is_true(isContinuation(text:byte(index + offset)),
                            "a character was cut short at byte " .. (index + offset))
                    end
                    index = index + width
                end
            end

            for _, case in ipairs({
                -- 511 bytes of ASCII, so the 512th byte would be the first half of an é and
                -- the cut has to walk back one.
                {
                    label = "a two-byte character straddling the cap",
                    raw = string.rep("x", 511) .. string.rep("é", 20),
                    text = string.rep("x", 511),
                },
                -- 510 bytes of ASCII, so the cut lands inside a three-byte character and has
                -- to walk back two.
                {
                    label = "a three-byte character straddling the cap",
                    raw = string.rep("x", 510) .. string.rep("語", 20),
                    text = string.rep("x", 510),
                },
                -- Nothing but two-byte characters, so the cap falls on a boundary already and
                -- the walk back must not take a whole character off for nothing.
                {
                    label = "a cap that already falls on a boundary",
                    raw = string.rep("é", 400),
                    text = string.rep("é", 256),
                },
            }) do
                it("cuts back off " .. case.label, function()
                    local text = ns.entryText(case.raw)

                    assert.is_true(#text <= ns.ENTRY_TEXT_MAX_BYTES,
                        "the note is " .. #text .. " bytes")
                    isWholeUtf8(text)
                    assert.equal(case.text, text)
                end)
            end
        end)

        -- The cut can leave a space hanging off the end, which is the one thing the trim
        -- before it could not have known about.
        it("trims a space the cut left at the end", function()
            local raw = string.rep("a", ns.ENTRY_TEXT_MAX_BYTES - 1) .. " tail"

            local text = ns.entryText(raw)

            assert.equal(string.rep("a", ns.ENTRY_TEXT_MAX_BYTES - 1), text)
        end)

        -- The cap is applied to what survived the escapes, not to what was pasted: a wall of
        -- colour codes is a short note rather than a note over the limit.
        it("measures what survived rather than what was pasted", function()
            local raw = string.rep("|cffff0000", 100) .. "short"

            assert.equal("shortr", ns.entryText(raw .. "|r"))
        end)
    end)
end)
