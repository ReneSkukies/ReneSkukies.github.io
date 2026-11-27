-- Bold every occurrence of the site owner's name in the bibliography.
-- publications.json is normalised to "Skukies, René" so citeproc prints
-- "Skukies, R." (initials only). Match "Skukies," followed by initials.
local function is_initial(s)
  return s:match("^%u%.[,;]?$") ~= nil
end

local function bold_names(inlines)
  local out = pandoc.List()
  local i = 1
  while i <= #inlines do
    local el = inlines[i]
    if el.t == "Str" and (el.text == "Skukies," or el.text == "Skukies") then
      local group = pandoc.List({el})
      local j = i + 1
      -- following initials, e.g. "R." or "R. S."
      while j + 1 <= #inlines
        and inlines[j].t == "Space"
        and inlines[j + 1].t == "Str"
        and is_initial(inlines[j + 1].text) do
        group:insert(inlines[j])
        group:insert(inlines[j + 1])
        j = j + 2
      end
      -- keep a trailing comma/semicolon outside the bold part
      local last = group[#group]
      local trailing = nil
      if last.t == "Str" and last.text:match("[,;]$") and #group > 1 then
        trailing = last.text:sub(-1)
        group[#group] = pandoc.Str(last.text:sub(1, -2))
      end
      out:insert(pandoc.Strong(group))
      if trailing then out:insert(pandoc.Str(trailing)) end
      i = j
    else
      out:insert(el)
      i = i + 1
    end
  end
  return out
end

function Div(div)
  if div.identifier == "refs" or div.classes:includes("csl-entry") or div.classes:includes("references") then
    return pandoc.walk_block(div, { Inlines = bold_names })
  end
end

-- Run citeproc ourselves (this filter runs before Quarto's own citeproc pass),
-- bold the owner's name in the generated bibliography, then drop `nocite` so
-- the later citeproc pass does not append the entries a second time.
function Pandoc(doc)
  if doc.meta.bibliography == nil then return nil end
  doc = pandoc.utils.citeproc(doc)
  doc = doc:walk({ Div = Div })
  doc.meta.nocite = nil
  return doc
end

return {
  { Pandoc = Pandoc },
}
