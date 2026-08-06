import { escapePromptXmlAttribute, formatPromptXmlCdata } from '@/utils/promptXml';

describe('prompt XML serialization', () => {
  it('escapes XML attributes, including whitespace controls', () => {
    expect(escapePromptXmlAttribute('a&"<>\t\n\r')).toBe(
      'a&amp;&quot;&lt;&gt;&#9;&#10;&#13;',
    );
  });

  it('normalizes invalid XML code points', () => {
    expect(formatPromptXmlCdata('before\u0000after')).toBe(
      '<![CDATA[before�after]]>',
    );
  });

  it('splits CDATA terminators without changing literal content', () => {
    expect(formatPromptXmlCdata('before ]]> after')).toBe(
      '<![CDATA[before ]]]]><![CDATA[> after]]>',
    );
  });
});
