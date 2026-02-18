/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./components/**/*.{js,ts,jsx,tsx,mdx}",
        "./app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                brand: {
                    DEFAULT: '#3b82f6',
                    hover: '#60a5fa',
                    light: '#93c5fd',
                    dark: '#2563eb'
                }
            },
            screens: {
                '3xl': '1920px',  // TV/Large Desktop
                '4xl': '2560px',  // 4K TV/Large TV
            },
            keyframes: {
                'eq-bar-1': {
                    '0%, 100%': { height: '35%' },
                    '50%': { height: '100%' },
                },
                'eq-bar-2': {
                    '0%, 100%': { height: '70%' },
                    '50%': { height: '30%' },
                },
                'eq-bar-3': {
                    '0%, 100%': { height: '50%' },
                    '50%': { height: '90%' },
                },
            },
            animation: {
                'eq-bar-1': 'eq-bar-1 0.8s ease-in-out infinite',
                'eq-bar-2': 'eq-bar-2 0.6s ease-in-out infinite 0.15s',
                'eq-bar-3': 'eq-bar-3 0.75s ease-in-out infinite 0.3s',
            },
        },
    },
    plugins: [],
}