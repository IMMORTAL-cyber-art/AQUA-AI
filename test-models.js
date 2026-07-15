async function list() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY_1}`);
  const json = await res.json();
  if (json.models) {
    console.log(JSON.stringify(json.models.map(m => m.name), null, 2));
  } else {
    console.log(json);
  }
}
list();
