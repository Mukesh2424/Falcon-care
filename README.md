# 🧠 FalconCare – Health & Wellness Voice Companion

FalconCare is an AI-powered voice companion built as part of the  
**Murf AI Voice Agent Challenge – Day 3**.

It performs daily wellness check-ins by talking with the user, tracking mood, energy, stress, goals, and storing everything in a structured JSON file.

---

## 🚀 Features

- 🎤 Voice-based daily wellness check-in  
- 🧠 Mood, energy & stress tracking  
- 🎯 Daily goal & self-care collection  
- 📄 Persistent JSON logging system  
- 🔁 Uses past check-in data for personalized conversation  
- 🔊 Powered by **Murf Falcon TTS**  
- ⚙ Built using **Google AI Studio**

---

## 🛠 How It Works

1. The agent starts a daily check-in conversation.
2. It asks about:
   - Mood
   - Energy level
   - Stress factors
   - Daily goals
   - Self-care activity
3. It provides small, practical suggestions.
4. It summarizes the conversation.
5. Finally, it outputs a structured JSON object.

---

## 📦 JSON Data Format

Each session is stored like this:

```json
{
  "date": "YYYY-MM-DD HH:MM",
  "mood": "text",
  "energyLevel": "text",
  "stress": "text",
  "goals": ["goal1", "goal2"],
  "selfCare": "text",
  "agentSummary": "short supportive message"
}
