// Name pools for synthetic students (shared by seed-supabase.mjs and simulate-day.mjs).

export const FIRST = `Aaliyah Aarav Abigail Adam Aditi Adrian Aiden Aisha Alejandro Alexa Alexander Ali Alicia Amara Amelia Amir Ana Andrea Andrew Angela Anika Anthony Arjun Ashley Ava Avery Ayesha Benjamin Bianca Brandon Brian Caleb Camila Carlos Caroline Chen Chloe Christopher Claire Connor Daniel Daniela David Deepa Derek Diego Dylan Elena Eli Elijah Elizabeth Emeka Emily Emma Eric Ethan Evan Fatima Felipe Gabriel Gabriela Grace Hannah Harper Hiroshi Ian Ibrahim Isabel Isabella Ishaan Jack Jacob Jada Jake James Jasmine Javier Jayden Jessica Jia Jin John Jonathan Jordan Jose Joseph Joshua Julia Julian Justin Kai Karan Katherine Kavya Kayla Kenji Kevin Kiara Kyle Laila Lauren Leah Leo Liam Lily Lucas Luis Luna Madison Manuel Marcus Maria Mason Matthew Maya Megan Mei Mia Michael Min-jun Mohammed Nadia Naomi Natalie Nathan Neha Nicholas Nicole Nikhil Noah Nora Olivia Omar Owen Pablo Priya Rachel Rafael Rahul Rebecca Riya Rohan Rosa Ryan Sakura Samantha Samuel Sara Sarah Sean Shreya Sofia Sophia Sophie Stephanie Tanvi Tariq Taylor Tessa Thomas Tyler Valentina Victor Victoria Vikram Wei William Xavier Yara Yuki Yusuf Zachary Zara Zoe`.split(" ");
export const LAST = `Adams Ahmed Alvarez Anderson Bai Baker Banerjee Bennett Brooks Brown Campbell Carter Castillo Chan Chang Chaudhry Chen Cho Choi Clark Collins Cooper Cruz Das Davis Diaz Dubois Edwards Evans Fernandez Fischer Flores Foster Garcia Ghosh Gomez Gonzalez Gupta Hall Harris Hassan Hernandez Hill Ho Huang Hughes Iyer Jackson Jain James Jimenez Johnson Jones Joshi Kang Kapoor Kelly Khan Kim King Kumar Lee Lewis Li Lin Liu Lopez Martin Martinez Mehta Mendoza Miller Mitchell Moore Morales Morgan Murphy Murray Nair Nakamura Nelson Nguyen Novak O'Brien Okafor Ortiz Park Parker Patel Perez Phillips Pham Ramirez Ramos Rao Reddy Reyes Richardson Rivera Roberts Robinson Rodriguez Rossi Russo Sanchez Santos Sato Schmidt Scott Shah Sharma Silva Singh Smith Song Stewart Sullivan Tanaka Taylor Thomas Thompson Torres Tran Turner Vargas Verma Walker Wang Ward Watson White Williams Wilson Wong Wright Wu Xu Yang Yilmaz Young Zhang Zhao Zhou`.split(" ");

// lastname.f@northeastern.edu, with a number appended when taken
export function nuEmail(first, last, taken) {
  const base = `${last.toLowerCase().replace(/[^a-z]/g, "")}.${first[0].toLowerCase()}`;
  let email = `${base}@northeastern.edu`;
  for (let k = 2; taken.has(email); k++) email = `${base}${k}@northeastern.edu`;
  taken.add(email);
  return email;
}
