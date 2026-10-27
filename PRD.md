# Product Requirements Document (PRD)
# Project Name: Euro Glam Bd

## 1. Executive Summary & Vision
**Euro Glam Bd** is an advanced e-commerce web platform specializing in authentic skincare, makeup, and baby care products imported directly from Europe. Unlike traditional e-commerce sites, it integrates an intelligent AI Advisor system, automated safety checks for product combinations, climate-adaptation tips tailored for Bangladesh's environment, and smart reminders to enhance user experience and trust.

## 2. Target Audience & Personas
* **Beauty & Skincare Enthusiasts:** Looking for authentic European products, personalized routines, and skin safety advice.
* **Mothers & Families:** Seeking reliable, high-quality baby care products with proven authenticity.
* **Smart Shoppers:** Expecting discounts, loyalty rewards, new arrivals alerts, and hassle-free checkout.

## 3. Core Features & Functional Requirements

### A. AI Skin Advisor Chatbot & Disclaimer
* **Image & Query Upload:** Users can upload a photo of their skin/face along with specific queries or skin concerns.
* **AI Analysis:** The chatbot analyzes the image/query and suggests suitable products.
* **Mandatory Disclaimer:** A prominent disclaimer stating *"This is an aesthetic/skincare suggestion, not a medical prescription from a doctor"* must be visible during the chat session.

### B. Smart Cart Conflict Checker
* **Safety Validation:** When a user adds 2-3 products to the cart or clicks "Buy Now", the system analyzes active chemical components (e.g., Retinol, AHA/BHA, Vitamin C).
* **Alert System:** If conflicting products are selected together, the system triggers a warning message and suggests safer usage patterns (e.g., alternating between morning and night).

### C. Authenticity & Trust Verification
* **Import Proof Section:** Displaying European custom declarations, import invoices, or sourcing details managed by the admin.
* **Batch Number/Barcode Check:** Verification options for customers to check product authenticity.
* **Unboxing & Video Reviews:** Support for short video feedback and unboxing clips in the review section (with admin moderation).

### D. Climate & Environment Adaptation Guide
* **Contextual Suggestions:** Since European products are formulated for cold/dry climates, the AI and product detail pages will provide tips on how to adapt them for Bangladesh's hot and humid weather.

### E. Automated Expiry & Ending SMS Reminders
* **Usage Tracking:** Based on product volume and average usage duration, the system calculates when a skincare product is likely to finish or near expiry.
* **SMS Automation:** Triggers an automated SMS to the user's phone offering a re-order link.

### F. E-commerce Core Features & UI Layout
* **Full Home Page Experience:** Hero banners ("Reveal Your Natural Glow"), Shop By Category (Cleanser, Serum, Lipstick, Sunscreen), Best Sellers, and New Arrivals sections with smooth cards, pricing, discount badges, and quick "Add to Cart" actions.
* **Sub Sections & Exploration:** Focused filters for skin concerns, makeup types, and brand grids (e.g., flash sales with countdown timers).
* **Product View & Details:** Detailed product views featuring key benefits & description, usage instructions, ingredients, authenticity guarantee badges ("Formulated in Europe", "Cruelty-Free"), and real customer reviews with ratings.

## 4. Admin Panel Roles & Responsibilities
* **Product Management:** Add, edit, or delete products, manage inventory/stock levels, tag chemical ingredients (for conflict checking), set climate adaptation tips, and manage New Arrivals/Discounts.
* **Order Management:** View all incoming customer orders, update order statuses (Pending -> Processing -> Shipped -> Delivered), and handle order processing.
* **AI & Content Control:** Monitor chatbot recommendations, ensure mandatory medical disclaimers are active, and update product mapping for AI suggestions.
* **Authenticity Proof Control:** Upload European import invoices, custom papers, and source documents to maintain customer trust.
* **Review Moderation:** Review, approve, or delete customer text/video reviews to maintain quality and prevent spam.
