/** Fail closed for MCP schemas not representable by the existing text editor. */
export function parseMcpForm(schema: any, text: string): Record<string, unknown> {
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') throw new Error('Unsupported MCP form')
  const allowed = ['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema']
  if (Object.keys(schema).some(key => !allowed.includes(key))) throw new Error('Unsupported MCP schema constraint')
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error('Missing required field')
  for (const [key, field] of Object.entries(schema.properties) as [string, any][]) {
    if (!field || Object.keys(field).some(key => !['type', 'title', 'description', 'enum'].includes(key))) throw new Error('Unsupported MCP field constraint')
    if (!['string', 'number', 'integer', 'boolean'].includes(field.type)) throw new Error('Unsupported MCP field type')
    if (!Object.hasOwn(value, key)) continue
    const item = value[key]
    if (field.type === 'integer' ? !Number.isSafeInteger(item) : typeof item !== field.type) throw new Error('Invalid field type')
    if (field.enum && (!Array.isArray(field.enum) || !field.enum.includes(item))) throw new Error('Invalid field choice')
  }
  if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) throw new Error('Unknown MCP field')
  return value
}
